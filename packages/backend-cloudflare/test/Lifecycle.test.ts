import { describe, expect, it } from "@effect/vitest"
import { Turn } from "@sideband/protocol"
import { Duration, Schema } from "effect"
import * as Lifecycle from "../src/Relay/Lifecycle.ts"
import { key, result, SESSION, text } from "./Harness.ts"

const NOW = 1_000_000_000_000

const RESEND_WINDOW = Duration.toMillis(Lifecycle.RESEND_WINDOW)

const row = (name: string, fields: Partial<Lifecycle.TurnRow> = {}): Lifecycle.TurnRow => ({
  key: key(name),
  session: SESSION,
  payload_hash: `hash-say ${name}`,
  transcript: `say ${name}`,
  transcript_raw: null,
  state: "sent",
  outcome: null,
  steer_into: null,
  created_at: NOW - 1000,
  updated_at: NOW - 1000,
  ...fields
})

const session = (fields: Partial<Lifecycle.SessionRow> = {}): Lifecycle.SessionRow => ({
  name: SESSION,
  agent_session_id: null,
  active_key: null,
  context_used: null,
  context_limit: null,
  last_activity: null,
  ...fields
})

const slice = (
  turns: ReadonlyArray<Lifecycle.TurnRow>,
  sessions: ReadonlyArray<Lifecycle.SessionRow> = []
): Lifecycle.Slice => ({ turns, sessions })

const hello = (inFlight: ReadonlyArray<string> = []) =>
  ({ type: "hello", protocol: 2, runner_version: "1.0.0", agent: { name: "Hermes" }, in_flight: inFlight }) as const

/** The messages a step sends, in order. */
const sends = (step: Lifecycle.Step<unknown>) =>
  step.commands.flatMap((command) => Lifecycle.Command.guards.Send(command) ? [command.message] : [])

/** The keys a step wakes, in order. */
const wakes = (step: Lifecycle.Step<unknown>) =>
  step.commands.flatMap((command) => Lifecycle.Command.guards.Wake(command) ? [command.key] : [])

const written = (step: Lifecycle.Step<unknown>, name: string) => step.writes.turns.find((r) => r.key === key(name))

describe("submit", () => {
  it("a replayed key answers with the stored turn, even while offline", () => {
    const existing = row("a")
    const step = Lifecycle.submit(slice([existing]), text("a"), undefined, NOW)

    expect(step.answer).toEqual(Lifecycle.SubmitAnswer.cases.Replay.make({ row: existing }))
    expect(step.writes.turns).toEqual([])
    expect(step.commands).toEqual([])
  })

  it("a key reused for a different payload is a conflict, before checking the runner", () => {
    const step = Lifecycle.submit(slice([row("a")]), text("a", "something else"), undefined, NOW)

    expect(step.answer._tag).toBe("Conflict")
  })

  it("with no runner online, nothing is stored or sent", () => {
    const step = Lifecycle.submit(slice([]), text("a"), undefined, NOW)

    expect(step.answer._tag).toBe("Offline")
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

    expect(step.answer._tag).toBe("Busy")
    expect(step.writes).toEqual({ turns: [], sessions: [] })
  })

  it("a protocol 2 runner gets a turn into a busy session as a steer; the active turn stays active", () => {
    const step = Lifecycle.submit(
      slice([row("a")], [session({ active_key: key("a"), agent_session_id: "s1" })]),
      text("b"),
      { protocol: 2 },
      NOW
    )

    expect(step.answer).toEqual(Lifecycle.SubmitAnswer.cases.Hold.make({ key: key("b") }))
    expect(written(step, "b")).toMatchObject({ state: "sent", steer_into: key("a"), created_at: NOW })
    expect(step.writes.sessions).toEqual([
      session({ active_key: key("a"), agent_session_id: "s1", last_activity: NOW })
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
    const step = Lifecycle.submit(slice([], [session({ agent_session_id: "s1" })]), text("a"), { protocol: 2 }, NOW)

    expect(step.answer._tag).toBe("Hold")
    expect(written(step, "a")).toMatchObject({ state: "sent", steer_into: null, transcript_raw: null })
    expect(step.writes.sessions).toEqual([
      session({ active_key: key("a"), agent_session_id: "s1", last_activity: NOW })
    ])
    expect(sends(step)).toEqual([
      { type: "turn", key: key("a"), session: SESSION, agent_session_id: "s1", transcript: "say a" }
    ])
  })

  it("a session's first turn creates it, and is sent without an agent session", () => {
    const step = Lifecycle.submit(slice([]), { ...text("a"), transcriptRaw: "say a." }, { protocol: 2 }, NOW)

    expect(written(step, "a")?.transcript_raw).toBe("say a.")
    expect(step.writes.sessions).toEqual([session({ active_key: key("a"), last_activity: NOW })])
    expect(sends(step)).toEqual([{ type: "turn", key: key("a"), session: SESSION, transcript: "say a" }])
  })
})

describe("check", () => {
  it("with the runner online, answers it and touches nothing", () => {
    const step = Lifecycle.check(slice([row("a", { created_at: NOW - RESEND_WINDOW * 10 })]), online(), NOW)

    expect(step.answer).toEqual({ protocol: 2 })
    expect(step.writes.turns).toEqual([])
  })

  it("offline, a turn exactly the re-send window old becomes unknown; a younger one waits", () => {
    const step = Lifecycle.check(
      slice([row("old", { created_at: NOW - RESEND_WINDOW }), row("young", { created_at: NOW - RESEND_WINDOW + 1 })]),
      { online: false, protocol: 2 },
      NOW
    )

    expect(step.answer).toBeUndefined()
    expect(step.writes.turns.map((r) => [r.key, r.state])).toEqual([[key("old"), "unknown"]])
    expect(wakes(step)).toEqual([key("old")])
  })
})

const online = (): Lifecycle.RunnerView => ({ online: true, protocol: 2 })

describe("hello", () => {
  it("re-sends a turn younger than the re-send window, and expires one exactly that old", () => {
    const step = Lifecycle.hello(
      slice([row("old", { created_at: NOW - RESEND_WINDOW }), row("young", { created_at: NOW - RESEND_WINDOW + 1 })]),
      hello(),
      NOW
    )

    expect(sends(step).map((m) => m.type === "turn" && m.key)).toEqual([key("young")])
    expect(written(step, "young")).toMatchObject({ state: "sent", updated_at: NOW })
    expect(written(step, "old")).toMatchObject({ state: "unknown" })
    expect(wakes(step)).toEqual([key("old")])
  })

  it("leaves turns the runner is still executing alone", () => {
    const step = Lifecycle.hello(slice([row("a", { state: "acked" })]), hello([key("a")]), NOW)

    expect(step.writes.turns).toEqual([])
    expect(sends(step)).toEqual([])
  })

  it("never re-sends a steer, however recent", () => {
    const step = Lifecycle.hello(
      slice([row("a", { created_at: NOW - 3000 }), row("b", { steer_into: key("a"), created_at: NOW - 1 })]),
      hello([key("a")]),
      NOW
    )

    expect(sends(step)).toEqual([])
    expect(written(step, "b")).toMatchObject({ state: "unknown" })
  })

  it("re-sends oldest first, on each turn's agent session", () => {
    const step = Lifecycle.hello(
      slice(
        [row("b", { created_at: NOW - 1000 }), row("a", { created_at: NOW - 2000, session: "other" })],
        [session({ agent_session_id: "s-main" }), session({ name: "other", agent_session_id: "s-other" })]
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
})

describe("isOnline", () => {
  const stale = Duration.toMillis(Lifecycle.STALE_PING)

  it("a ping exactly the staleness limit old is still online; older is offline", () => {
    expect(Lifecycle.isOnline(0, NOW - stale, NOW)).toBe(true)
    expect(Lifecycle.isOnline(0, NOW - stale - 1, NOW)).toBe(false)
  })

  it("before the first ping, the connection time stands in", () => {
    expect(Lifecycle.isOnline(NOW - stale, undefined, NOW)).toBe(true)
    expect(Lifecycle.isOnline(NOW - stale - 1, undefined, NOW)).toBe(false)
  })
})

describe("ack", () => {
  it("moves a turn waiting to be received to acked", () => {
    for (const state of ["pending", "sent"] as const) {
      expect(Lifecycle.ack(slice([row("a", { state })]), key("a"), NOW).writes.turns).toEqual([
        row("a", { state: "acked", updated_at: NOW })
      ])
    }
  })

  it("leaves an acked or resolved turn alone, and ignores an unknown key", () => {
    for (const state of ["acked", "done", "unknown"] as const) {
      expect(Lifecycle.ack(slice([row("a", { state })]), key("a"), NOW).writes.turns).toEqual([])
    }

    expect(Lifecycle.ack(slice([]), key("a"), NOW).writes.turns).toEqual([])
  })
})

describe("outcome", () => {
  it("an outcome for a resolved turn changes nothing and wakes no one", () => {
    for (const state of ["done", "unknown"] as const) {
      const step = Lifecycle.outcome(
        slice([row("a", { state })], [session({ active_key: null })]),
        result("a"),
        NOW
      )

      expect(step.writes).toEqual({ turns: [], sessions: [] })
      expect(step.commands).toEqual([])
    }
  })

  it("an outcome for a key the relay doesn't know is ignored", () => {
    expect(Lifecycle.outcome(slice([]), result("a"), NOW).commands).toEqual([])
  })

  it("stores the outcome and wakes the turn's waiters", () => {
    const step = Lifecycle.outcome(slice([row("a")], [session({ active_key: key("a") })]), result("a"), NOW)

    expect(written(step, "a")).toMatchObject({ state: "done", outcome: result("a"), updated_at: NOW })
    expect(wakes(step)).toEqual([key("a")])
  })
})

describe("resolve", () => {
  it("the latest open steer into the active turn takes the session over", () => {
    const step = Lifecycle.resolve(
      slice(
        [
          row("a", { created_at: NOW - 3000 }),
          row("b", { steer_into: key("a"), created_at: NOW - 2000 }),
          row("c", { steer_into: key("a"), created_at: NOW - 1000 })
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
      slice(
        [row("a"), row("b", { steer_into: key("a"), state: "done" })],
        [session({ active_key: key("a") })]
      ),
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
      slice([row("a")], [session({ active_key: key("a"), agent_session_id: "s1", context_used: 5, context_limit: 9 })]),
      key("a"),
      result("a", "s2"),
      NOW
    )

    expect(step.writes.sessions).toEqual([
      session({ agent_session_id: "s2", active_key: null, last_activity: NOW })
    ])
  })

  it("expiring a turn and its open steer in one step leaves the session free", () => {
    const step = Lifecycle.check(
      slice(
        [
          row("a", { created_at: NOW - RESEND_WINDOW - 2 }),
          row("b", { steer_into: key("a"), created_at: NOW - RESEND_WINDOW - 1 })
        ],
        [session({ active_key: key("a") })]
      ),
      undefined,
      NOW
    )

    expect(step.writes.sessions).toEqual([session({ active_key: null, last_activity: NOW })])
    expect(wakes(step)).toEqual([key("a"), key("b")])
  })
})

describe("agentSessionAfter", () => {
  const before = session({ agent_session_id: "s1", context_used: 5, context_limit: 9, last_activity: 1 })

  it("keeps the context usage when none is reported and the agent session is the same", () => {
    expect(Lifecycle.agentSessionAfter(before, "s1", undefined, NOW)).toEqual({ ...before, last_activity: NOW })
  })

  it("clears the context usage when none is reported for a new agent session", () => {
    expect(Lifecycle.agentSessionAfter(before, "s2", undefined, NOW)).toEqual(
      session({ agent_session_id: "s2", last_activity: NOW })
    )
  })

  it("replaces the context usage when one is reported", () => {
    expect(Lifecycle.agentSessionAfter(before, "s1", { used_tokens: 7, limit_tokens: 10 }, NOW)).toEqual(
      session({ agent_session_id: "s1", context_used: 7, context_limit: 10, last_activity: NOW })
    )
  })
})

/** The client-facing state of turn `a` done with `outcome`. */
const done = (outcome: Lifecycle.Outcome, fields: Partial<Lifecycle.TurnRow> = {}) =>
  Lifecycle.turnState(row("a", { state: "done", outcome, transcript_raw: "say a.", ...fields }))

describe("turnState", () => {
  const decode = Schema.decodeUnknownSync(Turn.TurnState)

  it("a completed turn carries the answer and the raw transcript, never the agent session", () => {
    const state = done(
      Lifecycle.Outcome.cases.result.make({
        key: key("a"),
        agent_session_id: "s1",
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
    expect(done(result("a"), { transcript_raw: null })).not.toHaveProperty("transcript_raw")
  })

  it("every other outcome, and the unresolved states, decode as the protocol's turn state", () => {
    const states = [
      done(Lifecycle.Outcome.cases.needs_approval.make({ key: key("a"), agent_session_id: "s1", message: "ok?" })),
      done(Lifecycle.Outcome.cases.turn_failed.make({ key: key("a"), code: "interrupted", message: "stopped" })),
      done(Lifecycle.Outcome.cases.merged.make({ key: key("a"), into: key("b") })),
      Lifecycle.turnState(row("a", { state: "unknown" })),
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
        session({ active_key: key("a"), context_used: 1, context_limit: 2, last_activity: 0 })
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

describe("session ops", () => {
  it("offline, or with a turn running in the session, nothing is sent", () => {
    const op = { session: SESSION, op: "new", opId: "op-1" } as const

    expect(Lifecycle.sessionOp(slice([]), op, undefined).answer._tag).toBe("Offline")
    expect(Lifecycle.sessionOp(slice([], [session({ active_key: key("a") })]), op, { protocol: 2 }).answer._tag).toBe(
      "Busy"
    )
  })

  it("is sent on the session's agent session, and waits for the runner", () => {
    const step = Lifecycle.sessionOp(
      slice([], [session({ agent_session_id: "s1" })]),
      { session: SESSION, op: "compact", opId: "op-1" },
      { protocol: 2 }
    )

    expect(step.answer).toEqual(Lifecycle.SessionOpAnswer.cases.Wait.make({ opId: "op-1" }))
    expect(sends(step)).toEqual([
      { type: "session_op", op_id: "op-1", op: "compact", session: SESSION, agent_session_id: "s1" }
    ])
  })

  it("a success moves the session to the agent session it names; a failure changes nothing", () => {
    const success = Lifecycle.sessionOpAnswer(
      slice([], [session({ agent_session_id: "s1", context_used: 5, context_limit: 9 })]),
      {
        session: SESSION,
        opId: "op-1",
        outcome: { type: "session_op_result", op_id: "op-1", agent_session_id: "s2" }
      },
      NOW
    )

    expect(success.writes.sessions).toEqual([session({ agent_session_id: "s2", last_activity: NOW })])
    expect(success.commands).toEqual([
      Lifecycle.Command.cases.Answer.make({ opId: "op-1", reply: Lifecycle.SessionOpReply.cases.Ok.make({}) })
    ])

    const failure = Lifecycle.sessionOpAnswer(
      slice([], [session()]),
      {
        session: SESSION,
        opId: "op-1",
        outcome: { type: "session_op_failed", op_id: "op-1", code: "agent_failed", message: "no" }
      },
      NOW
    )

    expect(failure.writes.sessions).toEqual([])
  })

  it("the runner's answer becomes the reply to the waiting request", () => {
    expect(Lifecycle.sessionOpReply(undefined)._tag).toBe("NoAnswer")
    expect(Lifecycle.sessionOpReply({ type: "session_op_result", op_id: "op-1", agent_session_id: "s1" })._tag).toBe(
      "Ok"
    )
    expect(
      Lifecycle.sessionOpReply({ type: "session_op_failed", op_id: "op-1", code: "not_supported", message: "no" })
    ).toEqual(Lifecycle.SessionOpReply.cases.NotSupported.make({ message: "no" }))
    expect(
      Lifecycle.sessionOpReply({ type: "session_op_failed", op_id: "op-1", code: "agent_failed", message: "boom" })
    ).toEqual(Lifecycle.SessionOpReply.cases.Failed.make({ message: "boom" }))
  })
})

describe("alarm", () => {
  it("prunes turns past retention and runs again a cleanup interval later", () => {
    const step = Lifecycle.alarm(NOW)

    expect(step.writes.pruneBefore).toBe(NOW - Duration.toMillis(Lifecycle.TURN_RETENTION))
    expect(step.commands).toEqual([
      Lifecycle.Command.cases.SetAlarm.make({ at: NOW + Duration.toMillis(Lifecycle.CLEANUP_INTERVAL) })
    ])
  })
})
