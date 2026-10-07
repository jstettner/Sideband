import { Schema } from "effect"
import { AgentInfo, ContextUsage, SessionName } from "./common.ts"

/** Backend's view of a session. Served without contacting the agent. */
export const SessionState = Schema.Struct({
  name: SessionName,
  /** A turn is in flight in this session. */
  busy: Schema.Boolean,
  /** Last reported context usage. Absent if the agent hasn't reported any. */
  context: Schema.optionalKey(ContextUsage),
  last_activity: Schema.optionalKey(Schema.DateTimeUtcFromString)
})
export type SessionState = typeof SessionState.Type

export const Status = Schema.Struct({
  agent: Schema.Struct({
    ...AgentInfo.fields,
    /** A runner is connected right now. */
    online: Schema.Boolean
  }),
  session: SessionState
})
export type Status = typeof Status.Type
