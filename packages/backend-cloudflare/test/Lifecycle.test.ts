import { describe, expect, it } from "@effect/vitest"
import { Common, Turn } from "@sideband/protocol"
import { Duration, Option, Result, Schema } from "effect"
import * as Lifecycle from "../src/Relay/Lifecycle.ts"
import { agentSession, answerTag, key, millis, opId, result, SESSION, text } from "./Harness.ts"

const NOW = millis(1_000_000_000_000)

const RESEND_WINDOW = Duration.toMillis(Lifecycle.RESEND_WINDOW)

const ago = (ms: number) => millis(NOW - ms)

const row = (name: string, fields: Partial<Lifecycle.OpenTurnRow> = {}): Lifecycle.OpenTurnRow => ({
  key: key(name),
  session: SESSION,
  payload_hash: `hash-say ${name}`,
  transcript: `say ${name}`,
  transcript_raw: null,
  state: "sent",
  outcome: null,
  steer_into: null,
  created_at: ago(1000),
  updated_at: ago(1000),
  ...fields
})

const done = (name: string, outcome: Lifecycle.Outcome = result(name)): Lifecycle.TurnRow => ({
  ...row(name),
  state: "done",
  outcome
})

const lost = (name: string): Lifecycle.TurnRow => ({ ...row(name), state: "unknown" })

const session = (fields: Partial<Lifecycle.SessionRow> = {}): Lifecycle.SessionRow => ({
  name: SESSION,
  agent_session_id: null,
  active_key: null,
  context: null,
  last_activity: null,
  ...fields
})

const slice = (
  turns: ReadonlyArray<Lifecycle.TurnRow>,
  sessions: ReadonlyArray<Lifecycle.SessionRow> = [session()]
): Lifecycle.Slice => ({ turns, sessions })

const hello = (inFlight: ReadonlyArray<string> = []) => ({
  type: "hello" as const,
  protocol: 2 as const,
  runner_version: "1.0.0",
  agent: { name: "Hermes" },
  in_flight: inFlight.map(key)
})

/** The messages a step sends, in order. */
const sends = (step: Lifecycle.Step<unknown>) =>
  step.commands.flatMap((command) => Lifecycle.Command.guards.Send(command) ? [command.message] : [])

/** The keys a step settles, in order. */
const settled = (step: Lifecycle.Step<unknown>) =>
  step.commands.flatMap((command) => Lifecycle.Command.guards.TurnSettled(command) ? [command.key] : [])

const written = (step: Lifecycle.Step<unknown>, name: string) => step.writes.turns.find((r) => r.key === key(name))

describe("submit", () => {
  it("a replayed key answers with the stored turn, even while offline", () => {
    const existing = row("a")
    const step = Lifecycle.submit(slice([existing]), text("a"), undefined, NOW)

    expect(step.answer).toEqual(Result.succeed(Lifecycle.Accepted.cases.Replay.make({ row: existing })))
    expect(step.writes.turns).toEqual([])
    expect(step.commands).toEqual([])
  })

  it("a key reused for a different payload is a conflict, before checking the runner", () => {
    const step = Lifecycle.submit(slice([row("a")]), text("a", "something else"), undefined, NOW)

    expect(answerTag(step.answer)).toBe("IdempotencyConflict")
  })

  it("with no runner online, nothing is stored or sent", () => {
    const step = Lifecycle.submit(slice([]), text("a"), undefined, NOW)

    expect(answerTag(step.answer)).toBe("AgentOffline")
    expect(step.writes).toEqual({ turns: [], sessions: [] })
    expect(step.commands).toEqual([])
  })

  it("a protocol 1 runner can't take a steer: the session is busy", () => {
    const step = Lifecycle.submit(
      slice([row("a")], [session({ active_key: key("a") })]),
      text("b"),
      { protocol: 1 },
      NOW
    )

    expect(answerTag(step.answer)).toBe("SessionBusy")
    expect(step.writes).toEqual({ turns: [], sessions: [] })
  })

  it("a protocol 2 runner gets a turn into a busy session as a steer; the active turn stays active", () => {
    const step = Lifecycle.submit(
      slice([row("a")], [session({ active_key: key("a"), agent_session_id: agentSession("s1") })]),
      text("b"),
      { protocol: 2 },
      NOW
    )

    expect(step.answer).toEqual(Result.succeed(Lifecycle.Accepted.cases.Hold.make({ key: key("b") })))
    expect(written(step, "b")).toMatchObject({ state: "sent", steer_into: key("a"), created_at: NOW })
    expect(step.writes.sessions).toEqual([
      session({ active_key: key("a"), agent_session_id: agentSession("s1"), last_activity: NOW })
    ])
    expect(sends(step)).toEqual([{
      type: "steer",
      key: key("b"),
      into: key("a"),
      session: SESSION,
      agent_session_id: "s1",
      transcript: "say b"
    }])
  })

  it("a turn into an idle session is sent as a turn and becomes the session's active turn", () => {
    const step = Lifecycle.submit(
      slice([], [session({ agent_session_id: agentSession("s1") })]),
      text("a"),
      { protocol: 2 },
      NOW
    )

    expect(answerTag(step.answer)).toBe("Hold")
    expect(written(step, "a")).toMatchObject({ state: "sent", steer_into: null, transcript_raw: null })
    expect(step.writes.sessions).toEqual([
      session({ active_key: key("a"), agent_session_id: agentSession("s1"), last_activity: NOW })
    ])
    expect(sends(step)).toEqual([
      { type: "turn", key: key("a"), session: SESSION, agent_session_id: "s1", transcript: "say a" }
    ])
  })

  it("a session's first turn creates it, and is sent without an agent session", () => {
    const step = Lifecycle.submit(slice([], []), { ...text("a"), transcriptRaw: "say a." }, { protocol: 2 }, NOW)

    expect(written(step, "a")?.transcript_raw).toBe("say a.")
    expect(step.writes.sessions).toEqual([session({ active_key: key("a"), last_activity: NOW })])
    expect(sends(step)).toEqual([{ type: "turn", key: key("a"), session: SESSION, transcript: "say a" }])
  })
})

describe("check", () => {
  it("with the runner online, answers it and touches nothing", () => {
    const step = Lifecycle.check(slice([row("a", { created_at: ago(RESEND_WINDOW * 10) })]), online(), NOW)

    expect(step.answer).toEqual({ protocol: 2 })
    expect(step.writes.turns).toEqual([])
  })

  it("offline, a turn exactly the re-send window old becomes unknown; a younger one waits", () => {
    const step = Lifecycle.check(
      slice([row("old", { created_at: ago(RESEND_WINDOW) }), row("young", { created_at: ago(RESEND_WINDOW - 1) })]),
      { online: false, protocol: 2 },
      NOW
    )

    expect(step.answer).toBeUndefined()
    expect(step.writes.turns.map((r) => [r.key, r.state])).toEqual([[key("old"), "unknown"]])
    expect(settled(step)).toEqual([key("old")])
  })
})

const online = (): Lifecycle.RunnerView => ({ online: true, protocol: 2 })

describe("hello", () => {
  it("re-sends a turn younger than the re-send window, and expires one exactly that old", () => {
    const step = Lifecycle.hello(
      slice([row("old", { created_at: ago(RESEND_WINDOW) }), row("young", { created_at: ago(RESEND_WINDOW - 1) })]),
      hello(),
      NOW
    )

    expect(sends(step).map((m) => m.type === "turn" && m.key)).toEqual([key("young")])
    expect(written(step, "young")).toMatchObject({ state: "sent", updated_at: NOW })
    expect(written(step, "old")).toMatchObject({ state: "unknown" })
    expect(settled(step)).toEqual([key("old")])
  })

  it("leaves turns the runner is still executing alone", () => {
    const step = Lifecycle.hello(slice([row("a", { state: "acked" })]), hello(["a"]), NOW)

    expect(step.writes.turns).toEqual([])
    expect(sends(step)).toEqual([])
  })

  it("never re-sends a steer, however recent", () => {
    const step = Lifecycle.hello(
      slice([row("a", { created_at: ago(3000) }), row("b", { steer_into: key("a"), created_at: ago(1) })]),
      hello(["a"]),
      NOW
    )

    expect(sends(step)).toEqual([])
    expect(written(step, "b")).toMatchObject({ state: "unknown" })
  })

  it("re-sends oldest first, on each turn's agent session", () => {
    const other = Common.SessionName.make("other")

    const step = Lifecycle.hello(
      slice(
        [row("b", { created_at: ago(1000) }), row("a", { created_at: ago(2000), session: other })],
        [
          session({ agent_session_id: agentSession("s-main") }),
          session({ name: other, agent_session_id: agentSession("s-other") })
        ]
      ),
      hello(),
      NOW
    )

    expect(sends(step)).toEqual([
      { type: "turn", key: key("a"), session: "other", agent_session_id: "s-other", transcript: "say a" },
      { type: "turn", key: key("b"), session: SESSION, agent_session_id: "s-main", transcript: "say b" }
    ])
  })

  it("stores the agent's name, and attaches the hello to the socket before anything is sent", () => {
    const step = Lifecycle.hello(slice([row("a")]), hello(), NOW)

    expect(step.writes.agentName).toBe("Hermes")
    expect(step.commands[0]).toEqual(Lifecycle.Command.cases.Attach.make({ hello: hello() }))
  })

  it("a turn loaded without its session is a broken invariant, not a case", () => {
    expect(() => Lifecycle.hello(slice([row("a")], []), hello(), NOW)).toThrow(/without its session/)
  })
})

describe("isOnline", () => {
  const stale = Duration.toMillis(Lifecycle.STALE_PING)

  it("a ping exactly the staleness limit old is still online; older is offline", () => {
    expect(Lifecycle.isOnline(millis(0), NOW - stale, NOW)).toBe(true)
    expect(Lifecycle.isOnline(millis(0), NOW - stale - 1, NOW)).toBe(false)
  })

  it("before the first ping, the connection time stands in", () => {
    expect(Lifecycle.isOnline(ago(stale), undefined, NOW)).toBe(true)
    expect(Lifecycle.isOnline(ago(stale + 1), undefined, NOW)).toBe(false)
  })
})

describe("ack", () => {
  it("moves a sent turn to acked", () => {
    expect(Lifecycle.ack(slice([row("a")]), key("a"), NOW).writes.turns).toEqual([
      row("a", { state: "acked", updated_at: NOW })
    ])
  })

  it("leaves an acked or resolved turn alone, and ignores an unknown key", () => {
    for (const turn of [row("a", { state: "acked" }), done("a"), lost("a")]) {
      expect(Lifecycle.ack(slice([turn]), key("a"), NOW).writes.turns).toEqual([])
    }

    expect(Lifecycle.ack(slice([]), key("a"), NOW).writes.turns).toEqual([])
  })
})

describe("outcome", () => {
  it("an outcome for a resolved turn changes nothing and settles no one", () => {
    for (const turn of [done("a"), lost("a")]) {
      const step = Lifecycle.outcome(slice([turn]), result("a"), NOW)

      expect(step.writes).toEqual({ turns: [], sessions: [] })
      expect(step.commands).toEqual([])
    }
  })

  it("an outcome for a key the relay doesn't know is ignored", () => {
    expect(Lifecycle.outcome(slice([]), result("a"), NOW).commands).toEqual([])
  })

  it("stores the outcome and settles the turn's waiters", () => {
    const step = Lifecycle.outcome(slice([row("a")], [session({ active_key: key("a") })]), result("a"), NOW)

    expect(written(step, "a")).toMatchObject({ state: "done", outcome: result("a"), updated_at: NOW })
    expect(settled(step)).toEqual([key("a")])
  })
})

describe("resolve", () => {
  it("the latest open steer into the active turn takes the session over", () => {
    const step = Lifecycle.resolve(
      slice(
        [
          row("a", { created_at: ago(3000) }),
          row("b", { steer_into: key("a"), created_at: ago(2000) }),
          row("c", { steer_into: key("a"), created_at: ago(1000) })
        ],
        [session({ active_key: key("a") })]
      ),
      key("a"),
      Lifecycle.Outcome.cases.turn_failed.make({ key: key("a"), code: "agent_failed", message: "no" }),
      NOW
    )

    expect(step.writes.sessions).toEqual([session({ active_key: key("c"), last_activity: NOW })])
  })

  it("a resolved steer doesn't take the session over", () => {
    const step = Lifecycle.resolve(
      slice([row("a"), { ...done("b"), steer_into: key("a") }], [session({ active_key: key("a") })]),
      key("a"),
      undefined,
      NOW
    )

    expect(step.writes.sessions).toEqual([session({ active_key: null, last_activity: NOW })])
  })

  it("resolving a turn that isn't its session's active one leaves the session alone", () => {
    const step = Lifecycle.resolve(
      slice([row("a"), row("b")], [session({ active_key: key("b") })]),
      key("a"),
      undefined,
      NOW
    )

    expect(step.writes.sessions).toEqual([])
  })

  it("a result moves the session to the agent session it ran in", () => {
    const step = Lifecycle.resolve(
      slice([row("a")], [
        session({
          active_key: key("a"),
          agent_session_id: agentSession("s1"),
          context: { used_tokens: 5, limit_tokens: 9 }
        })
      ]),
      key("a"),
      result("a", "s2"),
      NOW
    )

    expect(step.writes.sessions).toEqual([
      session({ agent_session_id: agentSession("s2"), active_key: null, last_activity: NOW })
    ])
  })

  it("resolving a turn that isn't open is a broken invariant", () => {
    expect(() => Lifecycle.resolve(slice([done("a")]), key("a"), undefined, NOW)).toThrow(/not an open turn/)
  })

  it("expiring a turn and its open steer in one step leaves the session free", () => {
    const step = Lifecycle.check(
      slice(
        [
          row("a", { created_at: ago(RESEND_WINDOW + 2) }),
          row("b", { steer_into: key("a"), created_at: ago(RESEND_WINDOW + 1) })
        ],
        [session({ active_key: key("a") })]
      ),
      undefined,
      NOW
    )

    expect(step.writes.sessions).toEqual([session({ active_key: null, last_activity: NOW })])
    expect(settled(step)).toEqual([key("a"), key("b")])
  })
})

describe("agentSessionAfter", () => {
  const before = session({
    agent_session_id: agentSession("s1"),
    context: { used_tokens: 5, limit_tokens: 9 },
    last_activity: millis(1)
  })

  it("keeps the context usage when none is reported and the agent session is the same", () => {
    expect(Lifecycle.agentSessionAfter(before, agentSession("s1"), undefined, NOW)).toEqual({
      ...before,
      last_activity: NOW
    })
  })

  it("clears the context usage when none is reported for a new agent session", () => {
    expect(Lifecycle.agentSessionAfter(before, agentSession("s2"), undefined, NOW)).toEqual(
      session({ agent_session_id: agentSession("s2"), last_activity: NOW })
    )
  })

  it("replaces the context usage when one is reported", () => {
    expect(Lifecycle.agentSessionAfter(before, agentSession("s1"), { used_tokens: 7, limit_tokens: 10 }, NOW)).toEqual(
      session({
        agent_session_id: agentSession("s1"),
        context: { used_tokens: 7, limit_tokens: 10 },
        last_activity: NOW
      })
    )
  })
})

/** The client-facing state of turn `a` done with `outcome`. */
const doneState = (outcome: Lifecycle.Outcome, transcriptRaw: string | null = "say a.") =>
  Lifecycle.turnState({ ...done("a", outcome), transcript_raw: transcriptRaw })

describe("turnState", () => {
  const decode = Schema.decodeUnknownSync(Turn.TurnState)

  it("a completed turn carries the answer and the raw transcript, never the agent session", () => {
    const state = doneState(
      Lifecycle.Outcome.cases.result.make({
        key: key("a"),
        agent_session_id: agentSession("s1"),
        watch_text: "short",
        speak_text: "spoken",
        full_text: "long",
        context: { used_tokens: 1, limit_tokens: 2 }
      })
    )

    expect(state).toEqual({
      status: "completed",
      idempotency_key: key("a"),
      session: SESSION,
      transcript: "say a",
      transcript_raw: "say a.",
      watch_text: "short",
      speak_text: "spoken",
      full_text: "long",
      context: { used_tokens: 1, limit_tokens: 2 }
    })
    decode(state)
  })

  it("a completed turn without a raw transcript has none", () => {
    expect(doneState(result("a"), null)).not.toHaveProperty("transcript_raw")
  })

  it("every other outcome, and the open and lost states, decode as the protocol's turn state", () => {
    const states = [
      doneState(
        Lifecycle.Outcome.cases.needs_approval.make({
          key: key("a"),
          agent_session_id: agentSession("s1"),
          message: "ok?"
        })
      ),
      doneState(Lifecycle.Outcome.cases.turn_failed.make({ key: key("a"), code: "interrupted", message: "stopped" })),
      doneState(Lifecycle.Outcome.cases.merged.make({ key: key("a"), into: key("b") })),
      Lifecycle.turnState(lost("a")),
      Lifecycle.turnState(row("a", { state: "acked" }))
    ]

    expect(states.map((state) => decode(state).status)).toEqual([
      "needs_approval",
      "failed",
      "merged",
      "unknown",
      "running"
    ])

    for (const state of states) {
      expect(state).not.toHaveProperty("transcript_raw")
      expect(state).not.toHaveProperty("agent_session_id")
    }
  })
})

describe("sessionState", () => {
  it("reports busy, context, and last activity from the row", () => {
    expect(
      Lifecycle.sessionState(
        SESSION,
        session({ active_key: key("a"), context: { used_tokens: 1, limit_tokens: 2 }, last_activity: millis(0) })
      )
    ).toEqual({
      name: SESSION,
      busy: true,
      context: { used_tokens: 1, limit_tokens: 2 },
      last_activity: "1970-01-01T00:00:00.000Z"
    })
  })

  it("a session that doesn't exist yet is idle", () => {
    expect(Lifecycle.sessionState(SESSION, undefined)).toEqual({ name: SESSION, busy: false })
  })
})

describe("classifyFrame", () => {
  it("recognizes the heartbeat and runner messages", () => {
    expect(Lifecycle.classifyFrame("ping")._tag).toBe("Ping")
    expect(Lifecycle.classifyFrame(JSON.stringify({ type: "ack", key: key("a") }))).toEqual(
      Lifecycle.Frame.cases.Message.make({ message: { type: "ack", key: key("a") } })
    )
  })

  it("a hello that doesn't decode is rejected; any other bad frame is ignored", () => {
    expect(Lifecycle.classifyFrame(JSON.stringify({ ...hello(), protocol: 99 }))._tag).toBe("RejectHello")
    expect(Lifecycle.classifyFrame(JSON.stringify({ type: "ack" }))._tag).toBe("Ignore")
    expect(Lifecycle.classifyFrame("not json")._tag).toBe("Ignore")
  })
})

/** The runner's `session_op_failed` answer to `op-1`. */
const opFailed = (code: "not_supported" | "agent_failed", message: string) =>
  Option.some({ type: "session_op_failed", op_id: opId("op-1"), code, message } as const)

describe("session ops", () => {
  const op = { session: SESSION, op: "new", opId: opId("op-1") } as const

  it("offline, or with a turn running in the session, nothing is sent", () => {
    expect(answerTag(Lifecycle.sessionOp(slice([]), op, undefined).answer)).toBe("AgentOffline")
    expect(answerTag(Lifecycle.sessionOp(slice([], [session({ active_key: key("a") })]), op, { protocol: 2 }).answer))
      .toBe("SessionBusy")
  })

  it("is sent on the session's agent session, and waits for the runner", () => {
    const step = Lifecycle.sessionOp(
      slice([], [session({ agent_session_id: agentSession("s1") })]),
      { ...op, op: "compact" },
      { protocol: 2 }
    )

    expect(Result.isSuccess(step.answer)).toBe(true)
    expect(sends(step)).toEqual([
      { type: "session_op", op_id: "op-1", op: "compact", session: SESSION, agent_session_id: "s1" }
    ])
  })

  it("a success moves the session to the agent session it names; a failure changes nothing", () => {
    const success = { type: "session_op_result", op_id: opId("op-1"), agent_session_id: agentSession("s2") } as const

    const succeeded = Lifecycle.sessionOpAnswer(
      slice([], [session({ agent_session_id: agentSession("s1"), context: { used_tokens: 5, limit_tokens: 9 } })]),
      { session: SESSION, opId: opId("op-1"), outcome: success },
      NOW
    )

    expect(succeeded.writes.sessions).toEqual([session({ agent_session_id: agentSession("s2"), last_activity: NOW })])
    expect(succeeded.commands).toEqual([Lifecycle.Command.cases.Answer.make({ opId: opId("op-1"), outcome: success })])

    const failed = Lifecycle.sessionOpAnswer(
      slice([], [session()]),
      {
        session: SESSION,
        opId: opId("op-1"),
        outcome: { type: "session_op_failed", op_id: opId("op-1"), code: "agent_failed", message: "no" }
      },
      NOW
    )

    expect(failed.writes.sessions).toEqual([])
  })

  it("the runner's answer, or its absence, becomes the waiting request's result", () => {
    expect(Lifecycle.sessionOpResult(Option.none())).toEqual(
      Result.fail(new Lifecycle.OpFailed({ message: "The runner didn't answer." }))
    )
    expect(
      Lifecycle.sessionOpResult(
        Option.some({ type: "session_op_result", op_id: opId("op-1"), agent_session_id: agentSession("s1") })
      )
    ).toEqual(Result.void)
    expect(Lifecycle.sessionOpResult(opFailed("not_supported", "no"))).toEqual(
      Result.fail(new Lifecycle.OpNotSupported({ message: "no" }))
    )
    expect(Lifecycle.sessionOpResult(opFailed("agent_failed", "boom"))).toEqual(
      Result.fail(new Lifecycle.OpFailed({ message: "boom" }))
    )
  })
})

describe("alarm", () => {
  it("prunes turns past retention and runs again a cleanup interval later", () => {
    const step = Lifecycle.alarm(NOW)

    expect(step.writes.pruneBefore).toBe(NOW - Duration.toMillis(Lifecycle.TURN_RETENTION))
    expect(step.commands).toEqual([
      Lifecycle.Command.cases.SetAlarm.make({ at: Lifecycle.after(NOW, Lifecycle.CLEANUP_INTERVAL) })
    ])
  })
})
