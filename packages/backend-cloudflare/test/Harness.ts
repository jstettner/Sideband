/**
 * The relay's read → step → save loop over in-memory tables, recording every step. After each step it
 * checks the relay's invariants, so every scenario run through it tests them too:
 *
 * 1. A `done` or `unknown` turn never changes again.
 * 2. A session's `active_key` is null or an unresolved turn in that session.
 * 3. A steer is sent at most once.
 * 4. A turn is sent again only by `hello`, and never while it is in `in_flight`.
 */
import { expect } from "@effect/vitest"
import type { Runner } from "@sideband/protocol"
import { Duration } from "effect"
import * as Lifecycle from "../src/Relay/Lifecycle.ts"

/** A valid idempotency key (16+ characters) named `name`. */
export const key = (name: string): string => `${name}-turn-0000000000`

export const SESSION = "main"

export interface Harness {
  readonly turns: ReadonlyMap<string, Lifecycle.TurnRow>
  readonly sessions: ReadonlyMap<string, Lifecycle.SessionRow>
  readonly agentName: () => string | undefined
  readonly now: () => number
  readonly advance: (duration: Duration.Input) => void
  /** Runs one event: read its rows, step, save, check the invariants. */
  readonly run: <A>(
    event: Lifecycle.Event,
    step: (slice: Lifecycle.Slice, now: number) => Lifecycle.Step<A>
  ) => Lifecycle.Step<A>
  /** Every command so far, in order. */
  readonly commands: () => ReadonlyArray<Lifecycle.Command>
  /** A client's request: the check, then the submit with its answer. */
  readonly submit: (turn: Lifecycle.SubmitTurn, runner?: Lifecycle.RunnerView) => Lifecycle.SubmitAnswer
  /** The check every other RPC starts with. */
  readonly check: (runner?: Lifecycle.RunnerView) => Lifecycle.LiveRunner | undefined
  readonly hello: (inFlight?: ReadonlyArray<string>, protocol?: Runner.Hello["protocol"]) => void
  readonly ack: (key: string) => void
  readonly outcome: (outcome: Lifecycle.Outcome) => void
  /** The client-facing state of `key`. */
  readonly state: (key: string) => ReturnType<typeof Lifecycle.turnState>
}

export const online: Lifecycle.RunnerView = { online: true, protocol: 2 }

export const text = (name: string, transcript = `say ${name}`): Lifecycle.SubmitTurn => ({
  key: key(name),
  session: SESSION,
  transcript,
  payloadHash: `hash-${transcript}`
})

export const make = (): Harness => {
  const turns = new Map<string, Lifecycle.TurnRow>()
  const sessions = new Map<string, Lifecycle.SessionRow>()
  const commands: Array<Lifecycle.Command> = []
  /** Keys sent as a turn or steer so far. */
  const sent = new Set<string>()
  let agentName: string | undefined
  let now = 1_000_000_000_000

  const unresolved = () =>
    [...turns.values()].filter((row) => !Lifecycle.isResolved(row)).toSorted((a, b) => a.created_at - b.created_at)

  const source: Lifecycle.Source = {
    turn: (k) => turns.get(k),
    session: (name) => sessions.get(name),
    unresolvedTurns: unresolved,
    unresolvedSteersInto: (k) => unresolved().filter((row) => row.steer_into === k)
  }

  const checkInvariants = (before: ReadonlyMap<string, Lifecycle.TurnRow>) => {
    for (const [k, row] of before) {
      if (Lifecycle.isResolved(row) && turns.has(k)) expect(turns.get(k), `resolved turn ${k} changed`).toEqual(row)
    }

    for (const session of sessions.values()) {
      if (session.active_key === null) continue
      const active = turns.get(session.active_key)
      expect(active, `${session.name}'s active turn`).toBeDefined()
      expect(active && Lifecycle.isResolved(active), `${session.name}'s active turn is resolved`).toBe(false)
      expect(active?.session).toBe(session.name)
    }
  }

  const checkSends = (event: Lifecycle.Event, step: Lifecycle.Step<unknown>) => {
    for (const command of step.commands) {
      if (!Lifecycle.Command.guards.Send(command) || command.message.type === "session_op") continue
      const { message } = command

      if (sent.has(message.key)) {
        expect(message.type, `steer ${message.key} sent twice`).toBe("turn")
        expect(Lifecycle.Event.guards.Hello(event), `turn ${message.key} re-sent outside hello`).toBe(true)

        if (Lifecycle.Event.guards.Hello(event)) {
          expect(event.hello.in_flight, `turn ${message.key} re-sent while in flight`).not.toContain(message.key)
        }
      }

      sent.add(message.key)
    }
  }

  const run = <A>(event: Lifecycle.Event, step: (slice: Lifecycle.Slice, now: number) => Lifecycle.Step<A>) => {
    const before = new Map(turns)
    const result = step(Lifecycle.read(source, event), now)

    for (const row of result.writes.turns) turns.set(row.key, row)

    for (const row of result.writes.sessions) sessions.set(row.name, row)

    if (result.writes.agentName !== undefined) agentName = result.writes.agentName

    if (result.writes.pruneBefore !== undefined) {
      for (const [k, row] of turns) {
        if (Lifecycle.isResolved(row) && row.updated_at < result.writes.pruneBefore) turns.delete(k)
      }
    }

    checkInvariants(before)
    checkSends(event, result)
    commands.push(...result.commands)

    return result
  }

  const check = (runner: Lifecycle.RunnerView | undefined = online) =>
    run(Lifecycle.Event.cases.Check.make({ runner }), (slice, t) => Lifecycle.check(slice, runner, t)).answer

  return {
    turns,
    sessions,
    agentName: () => agentName,
    now: () => now,
    advance: (duration) => {
      now += Duration.toMillis(Duration.fromInputUnsafe(duration))
    },
    run,
    commands: () => commands,
    check,
    submit: (turn, runner = online) => {
      const live = check(runner)

      return run(
        Lifecycle.Event.cases.Submit.make({ turn, runner: live }),
        (slice, t) => Lifecycle.submit(slice, turn, live, t)
      ).answer
    },
    hello: (inFlight = [], protocol = 2) => {
      const hello: Runner.Hello = {
        type: "hello",
        protocol,
        runner_version: "test",
        agent: { name: "Echo" },
        in_flight: inFlight
      }

      run(Lifecycle.Event.cases.Hello.make({ hello }), (slice, t) => Lifecycle.hello(slice, hello, t))
    },
    ack: (k) => {
      run(Lifecycle.Event.cases.Ack.make({ key: k }), (slice, t) => Lifecycle.ack(slice, k, t))
    },
    outcome: (result) => {
      run(Lifecycle.Event.cases.Outcome.make({ outcome: result }), (slice, t) => Lifecycle.outcome(slice, result, t))
    },
    state: (k) => {
      const row = turns.get(k)

      if (row === undefined) throw new Error(`no turn ${k}`)

      return Lifecycle.turnState(row)
    }
  }
}

/** A `result` for `name`'s turn. */
export const result = (name: string, agentSessionId = "agent-session-1", watchText = `answer ${name}`) =>
  Lifecycle.Outcome.cases.result.make({
    type: "result",
    key: key(name),
    agent_session_id: agentSessionId,
    watch_text: watchText
  })
