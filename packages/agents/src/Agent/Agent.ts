import { Common } from "@sideband/protocol"
import { Context, type Effect, Schema } from "effect"

/** The agent couldn't be reached or answered unexpectedly. Whether the turn ran is unknown. */
export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()("AgentUnavailable", {
  message: Schema.String
}) {}

/** The agent can't do this session operation (e.g. compaction). */
export class NotSupported extends Schema.TaggedError<NotSupported>()("NotSupported", {
  message: Schema.String
}) {}

/** How a turn ended at the agent. */
export const TurnOutcome = Schema.TaggedUnion({
  Completed: {
    /** Agent session the turn ran in; may differ from the one passed in. */
    agentSessionId: Schema.String,
    watchText: Schema.String,
    fullText: Schema.optional(Schema.String),
    context: Schema.optional(Common.ContextUsage),
    /** Steer text that arrived too late for this answer. The agent dropped it; the caller may run it. */
    pendingSteer: Schema.optional(Schema.String)
  },
  NeedsApproval: { agentSessionId: Schema.String, message: Schema.String },
  Failed: { code: Schema.Literals(["agent_failed", "interrupted"]), message: Schema.String }
}).annotate({ identifier: "TurnOutcome" })

export type TurnOutcome = typeof TurnOutcome.Type

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
    { readonly agentSessionId: string; readonly context?: Common.ContextUsage | undefined },
    NotSupported | AgentUnavailable
  >
}>()("@sideband/agents/Agent") {}
