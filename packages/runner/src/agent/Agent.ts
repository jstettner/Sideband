import type { ContextUsage } from "@sideband/protocol"
import { Context, Data, Effect, Layer } from "effect"
import { EchoConfig } from "../config.ts"

/** The agent couldn't be reached or answered unexpectedly. Whether the turn ran is unknown. */
export class AgentUnavailable extends Data.TaggedError("AgentUnavailable")<{
  readonly message: string
}> {}

/** The agent can't do this session operation (e.g. compaction). */
export class NotSupported extends Data.TaggedError("NotSupported")<{
  readonly message: string
}> {}

export type TurnOutcome =
  | {
    readonly _tag: "Completed"
    /** Agent session the turn ran in; may differ from the one passed in. */
    readonly agentSessionId: string
    readonly watchText: string
    readonly fullText?: string | undefined
    readonly context?: ContextUsage | undefined
    /** Steer text that arrived too late for this answer. The agent dropped it; the caller may run it. */
    readonly pendingSteer?: string | undefined
  }
  | { readonly _tag: "NeedsApproval"; readonly agentSessionId: string; readonly message: string }
  | { readonly _tag: "Failed"; readonly code: "agent_failed" | "interrupted"; readonly message: string }

/** One agent behind the runner. Adapters are layers; the rest of the runner only sees this. */
export class Agent extends Context.Service<Agent, {
  /** Display name sent to the relay in `hello`. */
  readonly name: string
  /**
   * Runs one turn. `key` is the turn's idempotency key: an adapter must make sure a key runs at
   * most once against the agent (see protocol/runner.md, "Never twice").
   */
  readonly runTurn: (turn: {
    readonly key: string
    readonly agentSessionId?: string | undefined
    readonly transcript: string
  }) => Effect.Effect<TurnOutcome, AgentUnavailable>
  /**
   * Adds `transcript` to the running turn `key`, to be answered by its outcome. `NotRunning`: the
   * turn isn't running (any more) and nothing was delivered. Never retried: steers aren't
   * idempotent, so after `AgentUnavailable` the steer may or may not have been delivered.
   */
  readonly steerTurn: (steer: {
    readonly key: string
    readonly transcript: string
  }) => Effect.Effect<"Steered" | "NotRunning", AgentUnavailable>
  readonly sessionOp: (
    op: "new" | "compact",
    agentSessionId?: string | undefined
  ) => Effect.Effect<
    { readonly agentSessionId: string; readonly context?: ContextUsage | undefined },
    NotSupported | AgentUnavailable
  >
}>()("sideband/runner/agent/Agent") {
  /**
   * Answers with the transcript. No side effects, so it needs no idempotency ledger.
   *
   * With `SIDEBAND_ECHO_DELAY_MS`, a turn takes that long and can be steered meanwhile: steers
   * are added to the answer, except those in the last quarter of the delay, which come back as
   * `pendingSteer` (like Hermes when the final reply is already being written).
   */
  static readonly layerEcho = Layer.effect(
    Agent,
    Effect.gen(function*() {
      const { delayMs } = yield* EchoConfig
      const running = new Map<string, { readonly lateAt: number; steers: Array<string>; late: Array<string> }>()

      return Agent.of({
        name: "echo",
        runTurn: Effect.fn("Agent.runTurn")(function*({ key, agentSessionId, transcript }) {
          const turn = { lateAt: Date.now() + delayMs * 0.75, steers: [], late: [] }
          running.set(key, turn)
          yield* Effect.sleep(delayMs).pipe(Effect.ensuring(Effect.sync(() => running.delete(key))))

          return {
            _tag: "Completed" as const,
            agentSessionId: agentSessionId ?? newEchoSession(),
            watchText: [transcript, ...turn.steers.map((steer) => `+ ${steer}`)].join("\n"),
            pendingSteer: turn.late.length > 0 ? turn.late.join("\n") : undefined
          }
        }),
        steerTurn: Effect.fn("Agent.steerTurn")(({ key, transcript }) =>
          Effect.sync(() => {
            const turn = running.get(key)

            if (!turn) return "NotRunning"

            if (Date.now() < turn.lateAt) turn.steers.push(transcript)
            else turn.late.push(transcript)

            return "Steered"
          })
        ),
        sessionOp: Effect.fn("Agent.sessionOp")(function*(op) {
          if (op !== "new") return yield* new NotSupported({ message: "echo has no context to compact" })

          return { agentSessionId: newEchoSession() }
        })
      })
    })
  )
}

const newEchoSession = () => `echo-${crypto.randomUUID()}`
