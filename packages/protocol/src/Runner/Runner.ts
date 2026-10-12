import { Schema } from "effect"
import { AgentInfo, ContextUsage, IdempotencyKey, SessionName } from "../Common/Common.ts"

/**
 * WebSocket messages between a backend's relay and a runner. See protocol/runner.md.
 *
 * Every message is a JSON text frame discriminated by `type`, except the heartbeat, which is
 * the literal text frames `ping` (runner → relay) and `pong` (relay → runner).
 */

/** Current version. 2 added steering (`steer`, `merged`); relays also accept 1. */
export const RUNNER_PROTOCOL_VERSION = 2

export const HEARTBEAT_PING = "ping"

export const HEARTBEAT_PONG = "pong"

const OpId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u))

// runner → relay

/** First message on every connection, including reconnects. */
export const Hello = Schema.Struct({
  type: Schema.tag("hello"),
  protocol: Schema.Literals([1, RUNNER_PROTOCOL_VERSION]),
  runner_version: Schema.String,
  agent: AgentInfo,
  /** Turns this runner process is still executing, so the relay doesn't re-send them. */
  in_flight: Schema.Array(IdempotencyKey)
}).annotate({ identifier: "Hello" })

export type Hello = typeof Hello.Type

/** The runner received a turn and handed it to the agent. */
export const Ack = Schema.Struct({
  type: Schema.tag("ack"),
  key: IdempotencyKey
}).annotate({ identifier: "Ack" })

export type Ack = typeof Ack.Type

export const TurnResult = Schema.Struct({
  type: Schema.tag("result"),
  key: IdempotencyKey,
  /** Agent session the turn ran in; may differ from the one sent (e.g. after compaction). */
  agent_session_id: Schema.String,
  watch_text: Schema.String,
  speak_text: Schema.optionalKey(Schema.String),
  full_text: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(ContextUsage)
}).annotate({ identifier: "TurnResult" })

export type TurnResult = typeof TurnResult.Type

export const TurnNeedsApproval = Schema.Struct({
  type: Schema.tag("needs_approval"),
  key: IdempotencyKey,
  agent_session_id: Schema.String,
  message: Schema.String
}).annotate({ identifier: "RunnerTurnNeedsApproval" })

export type TurnNeedsApproval = typeof TurnNeedsApproval.Type

export const TurnFailed = Schema.Struct({
  type: Schema.tag("turn_failed"),
  key: IdempotencyKey,
  code: Schema.Literals(["agent_failed", "interrupted"]),
  message: Schema.String
}).annotate({ identifier: "RunnerTurnFailed" })

export type TurnFailed = typeof TurnFailed.Type

/**
 * A steer was folded into turn `into`: that turn's outcome answers it too. Sent after `into`'s
 * outcome.
 */
export const TurnMerged = Schema.Struct({
  type: Schema.tag("merged"),
  key: IdempotencyKey,
  into: IdempotencyKey
}).annotate({ identifier: "RunnerTurnMerged" })

export type TurnMerged = typeof TurnMerged.Type

export const SessionOpResult = Schema.Struct({
  type: Schema.tag("session_op_result"),
  op_id: OpId,
  agent_session_id: Schema.String,
  context: Schema.optionalKey(ContextUsage)
}).annotate({ identifier: "SessionOpResult" })

export type SessionOpResult = typeof SessionOpResult.Type

export const SessionOpFailed = Schema.Struct({
  type: Schema.tag("session_op_failed"),
  op_id: OpId,
  code: Schema.Literals(["not_supported", "agent_failed"]),
  message: Schema.String
}).annotate({ identifier: "SessionOpFailed" })

export type SessionOpFailed = typeof SessionOpFailed.Type

export const RunnerMessage = Schema.Union([
  Hello,
  Ack,
  TurnResult,
  TurnNeedsApproval,
  TurnFailed,
  TurnMerged,
  SessionOpResult,
  SessionOpFailed
]).annotate({ identifier: "RunnerMessage" }).pipe(Schema.toTaggedUnion("type"))

export type RunnerMessage = typeof RunnerMessage.Type

// relay → runner

/** Run one turn. The runner passes `key` to the agent as its idempotency key. */
export const Turn = Schema.Struct({
  type: Schema.tag("turn"),
  key: IdempotencyKey,
  session: SessionName,
  /** Agent session to continue. Absent for a session's first turn. */
  agent_session_id: Schema.optionalKey(Schema.String),
  transcript: Schema.String
}).annotate({ identifier: "RunnerTurn" })

export type Turn = typeof Turn.Type

/**
 * Fold `transcript` into the running turn `into` (protocol 2). If `into` is no longer running,
 * the runner runs it as a normal turn under `key`. Never re-sent by the relay: steers have no
 * idempotency at the agent.
 */
export const Steer = Schema.Struct({
  type: Schema.tag("steer"),
  key: IdempotencyKey,
  into: IdempotencyKey,
  session: SessionName,
  /** Agent session of `into`, for running the steer as its own turn. */
  agent_session_id: Schema.optionalKey(Schema.String),
  transcript: Schema.String
}).annotate({ identifier: "Steer" })

export type Steer = typeof Steer.Type

export const SessionOp = Schema.Struct({
  type: Schema.tag("session_op"),
  op_id: OpId,
  op: Schema.Literals(["new", "compact"]),
  session: SessionName,
  agent_session_id: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "SessionOp" })

export type SessionOp = typeof SessionOp.Type

export const RelayMessage = Schema.Union([Turn, Steer, SessionOp]).annotate({ identifier: "RelayMessage" }).pipe(
  Schema.toTaggedUnion("type")
)

export type RelayMessage = typeof RelayMessage.Type
