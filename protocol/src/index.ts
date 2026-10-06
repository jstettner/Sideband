import { Schema } from "effect"

/** Context-window occupancy of the agent session, as reported by the runner. */
export const ContextUsage = Schema.Struct({
  used_tokens: Schema.Finite,
  limit_tokens: Schema.Finite,
  ratio: Schema.Finite
})
export type ContextUsage = typeof ContextUsage.Type
