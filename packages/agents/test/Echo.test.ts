import { describe, expect, it } from "@effect/vitest"
import { Common } from "@sideband/protocol"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { Agent, Echo } from "../src/index.ts"
import { agentContract } from "../src/testing/index.ts"

agentContract("Echo", Echo.layer({ delayMs: 0 }))

const KEY = Common.IdempotencyKey.make("echo-test-turn-0001")

describe("Echo with a delay", () => {
  it.effect("adds steers to the answer, except those in the last quarter, which come back as pendingSteer", () =>
    Effect.gen(function*() {
      const agent = yield* Agent.Agent
      const turn = yield* agent.runTurn({ key: KEY, transcript: "count to three" }).pipe(Effect.forkChild)

      yield* TestClock.adjust("100 millis")
      expect(yield* agent.steerTurn({ key: KEY, transcript: "in French" })).toBe("Steered")

      yield* TestClock.adjust("700 millis")
      expect(yield* agent.steerTurn({ key: KEY, transcript: "slowly" })).toBe("Steered")

      yield* TestClock.adjust("200 millis")

      expect(yield* Fiber.join(turn)).toEqual(
        Agent.TurnOutcome.cases.Completed.make({
          agentSessionId: Common.AgentSessionId.make(`echo-${KEY}`),
          watchText: "count to three\n+ in French",
          pendingSteer: "slowly"
        })
      )
      expect(yield* agent.steerTurn({ key: KEY, transcript: "too late" })).toBe("NotRunning")
    }).pipe(Effect.provide(Echo.layer({ delayMs: 1000 }))))
})
