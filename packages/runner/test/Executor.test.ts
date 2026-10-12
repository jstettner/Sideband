import { describe, expect, it } from "@effect/vitest"
import { Agent } from "@sideband/agents"
import type { Runner } from "@sideband/protocol"
import { Context, Effect, Exit, Latch, Layer, Queue, Scope } from "effect"
import { type Emit, Executor } from "../src/Executor/Executor.ts"

const KEY = "turn-0000000000000001"

const STEER = "turn-0000000000000002"

const turn: Runner.Turn = { type: "turn", key: KEY, session: "main", transcript: "Deploy it." }

const steer: Runner.Steer = { type: "steer", key: STEER, into: KEY, session: "main", transcript: "to staging" }

const { Completed } = Agent.TurnOutcome.cases

const completed = Completed.make({ agentSessionId: "session-1", watchText: "Deployed." })

type Agent = Agent.Agent["Service"]

/** An agent whose turns answer `completed` once `gate` opens, counting the turns it ran. */
const scripted = (gate: Latch.Latch, overrides: Partial<Agent> = {}) => {
  const runs: Array<string> = []

  const agent: Agent = {
    name: "scripted",
    runTurn: Effect.fnUntraced(function*({ key }) {
      runs.push(key)
      yield* gate.await

      return completed
    }),
    steerTurn: Effect.fnUntraced(function*() {
      return yield* Effect.succeed("Steered" as const)
    }),
    sessionOp: Effect.fnUntraced(function*() {
      return yield* Effect.succeed({ agentSessionId: "session-2" })
    }),
    ...overrides
  }

  return { runs, layer: Executor.layer.pipe(Layer.provide(Layer.succeed(Agent.Agent)(agent))) }
}

/** The executor over `layer`, alive until the test's scope (or `scope`) closes. */
const start = (layer: Layer.Layer<Executor>, scope?: Scope.Scope) =>
  (scope ? Layer.buildWithScope(layer, scope) : Layer.build(layer)).pipe(
    Effect.map((context) => Context.get(context, Executor))
  )

/** An `Emit` that queues what the executor sends, so a test can wait for each message. */
const recorder = Effect.gen(function*() {
  const sent = yield* Queue.unbounded<Runner.RunnerMessage>()
  const emit: Emit = (message) => Queue.offer(sent, message).pipe(Effect.asVoid)

  return { emit, next: Queue.take(sent), pending: Queue.size(sent) }
})

describe("Executor", () => {
  it.effect("acks a turn before running it, then sends exactly one outcome", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const { layer } = scripted(gate)
      const { emit, next, pending } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.run(turn, emit)
      expect(yield* next).toEqual({ type: "ack", key: KEY })
      expect(yield* pending).toBe(0)

      yield* gate.open
      expect(yield* next).toEqual({ type: "result", key: KEY, agent_session_id: "session-1", watch_text: "Deployed." })
      expect(yield* pending).toBe(0)
    }))

  it.effect("a turn re-sent while it runs is acked again and runs once", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const { layer, runs } = scripted(gate)
      const { emit, next, pending } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.run(turn, emit)
      yield* executor.run(turn, emit)
      expect([yield* next, yield* next]).toEqual([{ type: "ack", key: KEY }, { type: "ack", key: KEY }])

      yield* gate.open
      expect((yield* next).type).toBe("result")
      expect(runs).toEqual([KEY])
      expect(yield* pending).toBe(0)
    }))

  it.effect("a turn is in flight until its outcome is sent", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const { layer } = scripted(gate)
      const { emit, next } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.run(turn, emit)
      expect(yield* executor.inFlight).toEqual([KEY])

      yield* gate.open
      yield* next
      yield* next
      yield* Effect.yieldNow
      expect(yield* executor.inFlight).toEqual([])
    }))

  it.effect("an unavailable agent fails the turn", () =>
    Effect.gen(function*() {
      const { layer } = scripted(Latch.makeUnsafe(true), {
        runTurn: Effect.fnUntraced(function*() {
          return yield* new Agent.AgentUnavailable({ message: "connection refused" })
        })
      })

      const { emit, next } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.run(turn, emit)
      yield* next
      expect(yield* next).toEqual({
        type: "turn_failed",
        key: KEY,
        code: "agent_failed",
        message: "connection refused"
      })
    }))

  it.effect("an agent that crashes fails the turn", () =>
    Effect.gen(function*() {
      const { layer } = scripted(Latch.makeUnsafe(true), {
        runTurn: Effect.fnUntraced(function*() {
          return yield* Effect.die("bug")
        })
      })

      const { emit, next } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.run(turn, emit)
      yield* next
      expect(yield* next).toMatchObject({ type: "turn_failed", key: KEY, code: "agent_failed" })
    }))

  it.effect("a turn interrupted by shutdown sends no outcome, so the relay re-sends it", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const { layer } = scripted(gate)
      const { emit, next, pending } = yield* recorder
      const scope = yield* Scope.make()
      const executor = yield* start(layer, scope)

      yield* executor.run(turn, emit)
      yield* next
      yield* Scope.close(scope, Exit.void)
      expect(yield* pending).toBe(0)
    }))

  it.effect("a steer the agent took is merged after the outcome of the turn it went into", () =>
    Effect.gen(function*() {
      const gate = yield* Latch.make()
      const { layer } = scripted(gate)
      const { emit, next } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.run(turn, emit)
      yield* executor.steer(steer, emit)
      yield* gate.open

      const sent = [yield* next, yield* next, yield* next, yield* next]

      expect(sent.map((m) => `${m.type} ${"key" in m ? m.key : ""}`)).toEqual([
        `ack ${KEY}`,
        `ack ${STEER}`,
        `result ${KEY}`,
        `merged ${STEER}`
      ])
      expect(sent[3]).toEqual({ type: "merged", key: STEER, into: KEY })
    }))

  it.effect("a steer into a turn that isn't running here runs as a turn of its own", () =>
    Effect.gen(function*() {
      const { layer, runs } = scripted(Latch.makeUnsafe(true))
      const { emit, next } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.steer(steer, emit)
      expect(yield* next).toEqual({ type: "ack", key: STEER })
      expect(yield* next).toMatchObject({ type: "result", key: STEER })
      expect(runs).toEqual([STEER])
    }))

  it.effect("a session operation the agent can't do fails as not_supported", () =>
    Effect.gen(function*() {
      const { layer } = scripted(Latch.makeUnsafe(true), {
        sessionOp: Effect.fnUntraced(function*() {
          return yield* new Agent.NotSupported({ message: "no compaction" })
        })
      })

      const { emit, next } = yield* recorder
      const executor = yield* start(layer)

      yield* executor.sessionOp({ type: "session_op", op_id: "op-1", op: "compact", session: "main" }, emit)
      expect(yield* next).toEqual({
        type: "session_op_failed",
        op_id: "op-1",
        code: "not_supported",
        message: "no compaction"
      })
    }))
})
