import { describe, expect, it } from "@effect/vitest"
import { Common } from "@sideband/protocol"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "../src/index.ts"
import { agentContract, type HermesScript, layerHermes, makeHermesApi } from "../src/testing/index.ts"

agentContract("Hermes", layerHermes(makeHermesApi()))

const KEY = Common.IdempotencyKey.make("hermes-test-turn-0001")

/** The session Hermes names after the first run. */
const RUN_SESSION = Common.AgentSessionId.make("run-1")

const turn = { key: KEY, transcript: "Did the deploy finish?" }

const { Completed, NeedsApproval, Failed } = Agent.TurnOutcome.cases

/** What the fake Hermes answers by default: the run's input, in the session the run named. */
const echoed = Completed.make({ agentSessionId: RUN_SESSION, watchText: turn.transcript })

/** Runs `turn` against a fake Hermes following `script`, advancing the clock until it settles. */
const runTurn = (script: HermesScript) => {
  const api = makeHermesApi(script)

  return Effect.gen(function*() {
    const running = yield* Agent.Agent.use((agent) => agent.runTurn(turn)).pipe(Effect.forkChild)
    yield* TestClock.adjust("1 minute")

    return { outcome: yield* Fiber.join(running), api }
  }).pipe(Effect.provide(layerHermes(api)))
}

describe("Hermes", () => {
  it.effect("a new run follows its event stream, then reads the settled status once", () =>
    Effect.gen(function*() {
      const { outcome, api } = yield* runTurn({})

      expect(outcome).toEqual(echoed)
      expect(api.requests).toEqual(["POST /v1/runs", "GET /v1/runs/run-1/events", "GET /v1/runs/run-1"])
    }))

  it.effect("a re-sent key attaches to the original run and polls it instead of taking its stream", () => {
    const api = makeHermesApi()

    return Effect.gen(function*() {
      const agent = yield* Agent.Agent
      const first = yield* agent.runTurn(turn)
      const requests = api.requests.length

      expect(yield* agent.runTurn(turn)).toEqual(first)
      expect(api.runsCreated()).toBe(1)
      expect(api.requests.slice(requests)).toEqual(["POST /v1/runs", "GET /v1/runs/run-1"])
    }).pipe(Effect.provide(layerHermes(api)))
  })

  it.effect("a lost event stream falls back to polling the status", () =>
    Effect.gen(function*() {
      const { outcome, api } = yield* runTurn({ eventsLost: true, pendingReads: 2 })

      expect(outcome).toEqual(echoed)
      expect(api.requests.filter((r) => r === "GET /v1/runs/run-1")).toHaveLength(3)
    }))

  it.effect("transient failures creating the run are retried under the same key", () =>
    Effect.gen(function*() {
      const { outcome, api } = yield* runTurn({ createUnavailable: 2 })

      expect(outcome).toEqual(echoed)
      expect(api.requests.filter((r) => r === "POST /v1/runs")).toHaveLength(3)
      expect(api.runsCreated()).toBe(1)
    }))

  it.effect("a run waiting for approval needs approval", () =>
    Effect.gen(function*() {
      const { outcome } = yield* runTurn({
        settle: (_, session_id) => ({
          status: "waiting_for_approval",
          session_id,
          approval: { description: "Run `rm -rf build`?" }
        })
      })

      expect(outcome).toEqual(NeedsApproval.make({ agentSessionId: RUN_SESSION, message: "Run `rm -rf build`?" }))
    }))

  it.effect("failed runs fail; interrupted and cancelled runs were interrupted", () =>
    Effect.gen(function*() {
      const failed = yield* runTurn({ settle: (_, session_id) => ({ status: "failed", session_id, error: "boom" }) })

      const interrupted = yield* runTurn({
        settle: (_, session_id) => ({ status: "interrupted", session_id, error: "gateway restarted" })
      })

      const cancelled = yield* runTurn({ settle: (_, session_id) => ({ status: "cancelled", session_id }) })

      expect(failed.outcome).toEqual(Failed.make({ code: "agent_failed", message: "boom" }))
      expect(interrupted.outcome).toEqual(Failed.make({ code: "interrupted", message: "gateway restarted" }))
      expect(cancelled.outcome).toEqual(Failed.make({ code: "interrupted", message: "The run was stopped in Hermes." }))
    }))

  it.effect("compacting isn't supported", () =>
    Effect.gen(function*() {
      const error = yield* Agent.Agent.use((agent) => agent.sessionOp("compact", RUN_SESSION)).pipe(Effect.flip)

      expect(error._tag).toBe("NotSupported")
    }).pipe(Effect.provide(layerHermes(makeHermesApi()))))
})
