import { describe, expect, it } from "@effect/vitest"
import * as Lifecycle from "../src/Relay/Lifecycle.ts"
import * as Harness from "./Harness.ts"

const { key, result, SESSION, text } = Harness

describe("relay scenarios", () => {
  it("submit → ack → result; replaying the key afterwards answers the same state", () => {
    const relay = Harness.make()
    relay.hello()

    expect(relay.submit(text("a"))._tag).toBe("Hold")
    expect(relay.state(key("a")).status).toBe("running")
    relay.ack(key("a"))
    relay.outcome(result("a"))

    const completed = relay.state(key("a"))
    expect(completed).toMatchObject({ status: "completed", watch_text: "answer a" })
    expect(relay.submit(text("a"))).toEqual(
      Lifecycle.SubmitAnswer.cases.Replay.make({ row: relay.turns.get(key("a"))! })
    )
    expect(relay.state(key("a"))).toEqual(completed)
    expect(relay.sessions.get(SESSION)).toMatchObject({ active_key: null, agent_session_id: "agent-session-1" })
  })

  it("a steer into a running turn is answered through it: merged once the turn's outcome is in", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.advance("1 second")
    relay.submit(text("b"))

    expect(relay.sessions.get(SESSION)?.active_key).toBe(key("a"))
    relay.outcome(result("a"))
    // The steer holds the session until its own outcome.
    expect(relay.sessions.get(SESSION)?.active_key).toBe(key("b"))
    relay.outcome(Lifecycle.Outcome.cases.merged.make({ key: key("b"), into: key("a") }))

    expect(relay.state(key("b"))).toMatchObject({ status: "merged", into: key("a") })
    expect(relay.sessions.get(SESSION)?.active_key).toBeNull()
  })

  it("a steer that arrives too late runs as its own turn and answers itself", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.submit(text("b"))
    relay.outcome(result("a"))
    relay.advance("5 seconds")
    relay.outcome(result("b", "agent-session-1", "late answer"))

    expect(relay.state(key("b"))).toMatchObject({ status: "completed", watch_text: "late answer" })
    expect(relay.sessions.get(SESSION)?.active_key).toBeNull()
  })

  it("a runner that reconnects within the re-send window gets the turn again", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.ack(key("a"))
    relay.advance("1 minute")
    relay.hello()

    expect(relay.commands().filter((c) => Lifecycle.Command.guards.Send(c))).toHaveLength(2)
    expect(relay.turns.get(key("a"))?.state).toBe("sent")
  })

  it("after the re-send window, a reconnect marks the turn unknown and wakes its waiters", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.advance("2 minutes")
    relay.hello()

    expect(relay.state(key("a")).status).toBe("unknown")
    expect(relay.commands().at(-1)).toEqual(Lifecycle.Command.cases.Wake.make({ key: key("a") }))
    expect(relay.sessions.get(SESSION)?.active_key).toBeNull()
  })

  it("with the runner offline, a status check after the re-send window expires the turn", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.advance("2 minutes")

    expect(relay.check({ online: false, protocol: 2 })).toBeUndefined()
    expect(relay.state(key("a")).status).toBe("unknown")
  })

  it("an outcome re-delivered after a reconnect is ignored", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.outcome(result("a", "agent-session-1", "first"))
    relay.hello([])
    relay.outcome(result("a", "agent-session-2", "second"))

    expect(relay.state(key("a"))).toMatchObject({ watch_text: "first" })
    expect(relay.sessions.get(SESSION)?.agent_session_id).toBe("agent-session-1")
  })

  it("a protocol 1 runner gets session_busy instead of a steer", () => {
    const relay = Harness.make()
    const v1: Lifecycle.RunnerView = { online: true, protocol: 1 }
    relay.hello([], 1)
    relay.submit(text("a"), v1)

    expect(relay.submit(text("b"), v1)._tag).toBe("Busy")
    expect(relay.turns.has(key("b"))).toBe(false)
  })

  it("a new session moves to the agent session the runner names, and forgets the old context", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.outcome(
      Lifecycle.Outcome.cases.result.make({
        key: key("a"),
        agent_session_id: "s1",
        watch_text: "hi",
        context: { used_tokens: 5, limit_tokens: 9 }
      })
    )

    const live = relay.check()
    const op = { session: SESSION, op: "new", opId: "op-1" } as const

    const asked = relay.run(
      Lifecycle.Event.cases.SessionOp.make({ ...op, runner: live }),
      (slice) => Lifecycle.sessionOp(slice, op, live)
    )

    expect(asked.answer._tag).toBe("Wait")

    const answer = {
      session: SESSION,
      opId: "op-1",
      outcome: { type: "session_op_result", op_id: "op-1", agent_session_id: "s2" }
    } as const

    relay.run(
      Lifecycle.Event.cases.SessionOpAnswer.make(answer),
      (slice, now) => Lifecycle.sessionOpAnswer(slice, answer, now)
    )

    expect(Lifecycle.sessionState(SESSION, relay.sessions.get(SESSION))).toEqual({
      name: SESSION,
      busy: false,
      last_activity: new Date(relay.now()).toISOString()
    })
    expect(relay.sessions.get(SESSION)?.agent_session_id).toBe("s2")
  })

  it("the alarm prunes resolved turns past retention and keeps the rest", () => {
    const relay = Harness.make()
    relay.hello()
    relay.submit(text("a"))
    relay.outcome(result("a"))
    relay.submit({ ...text("b"), session: "other" })
    relay.advance("8 days")
    relay.run(Lifecycle.Event.cases.Alarm.make({}), (_, now) => Lifecycle.alarm(now))

    expect([...relay.turns.keys()]).toEqual([key("b")])
  })
})
