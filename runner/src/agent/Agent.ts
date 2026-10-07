import type { ContextUsage } from "@sideband/protocol"
import { Context, Data, Effect, Layer } from "effect"

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
  readonly sessionOp: (
    op: "new" | "compact",
    agentSessionId?: string | undefined
  ) => Effect.Effect<
    { readonly agentSessionId: string; readonly context?: ContextUsage | undefined },
    NotSupported | AgentUnavailable
  >
}>()("sideband/runner/agent/Agent") {
  /** Answers with the transcript. No side effects, so it needs no idempotency ledger. */
  static readonly layerEcho = Layer.succeed(Agent)({
    name: "echo",
    runTurn: ({ agentSessionId, transcript }) =>
      Effect.succeed({
        _tag: "Completed",
        agentSessionId: agentSessionId ?? newEchoSession(),
        watchText: transcript
      }),
    sessionOp: (op) =>
      op === "new"
        ? Effect.succeed({ agentSessionId: newEchoSession() })
        : Effect.fail(new NotSupported({ message: "echo has no context to compact" }))
  })
}

const newEchoSession = () => `echo-${crypto.randomUUID()}`
