import { Schema } from "effect"

/**
 * Client-generated key identifying one turn end to end (watch → backend → runner → agent).
 * A retry of the same recorded command reuses the same key.
 */
export const IdempotencyKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{16,128}$/u)
).annotate({
  description: "16-128 characters of [A-Za-z0-9_-]. A UUID is fine."
}).pipe(Schema.brand("IdempotencyKey"))

export type IdempotencyKey = typeof IdempotencyKey.Type

/**
 * Stable, client-facing session name (e.g. `main`). The agent's own session ID can change
 * (new session, compaction) and never leaves the backend/runner.
 */
export const SessionName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/u)
).annotate({
  description: "Lowercase [a-z0-9_-], 1-64 characters, starting with a letter or digit."
}).pipe(Schema.brand("SessionName"))

export type SessionName = typeof SessionName.Type

/**
 * The agent's own id for a session behind a {@link SessionName}. Opaque to everything but the runner's adapter,
 * and never sent to clients.
 */
export const AgentSessionId = Schema.String.pipe(Schema.brand("AgentSessionId"))

export type AgentSessionId = typeof AgentSessionId.Type

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Context-window occupancy of the agent session, as reported by the agent. */
export const ContextUsage = Schema.Struct({
  used_tokens: TokenCount,
  limit_tokens: TokenCount
})

export type ContextUsage = typeof ContextUsage.Type

/** The agent behind the backend, for display. Clients must not hardcode the agent name. */
export const AgentInfo = Schema.Struct({
  name: Schema.String
}).annotate({ identifier: "AgentInfo" })

export type AgentInfo = typeof AgentInfo.Type
