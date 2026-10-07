import { Schema } from "effect"

/**
 * Error responses: the request was refused and no turn exists for it (or, for `not_found`,
 * never existed). Every error has the same shape:
 *
 *   { "error": "<code>", "message": "<human readable>", "retryable": <bool> }
 *
 * `retryable: true` means retrying the same request (same `Idempotency-Key` for turns) is safe
 * and may succeed. Clients treat unknown codes as non-retryable.
 */

export class Unauthorized extends Schema.Error<Unauthorized>("Unauthorized")({
  error: Schema.Literal("unauthorized"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 401 }) {}

export class InvalidRequest extends Schema.Error<InvalidRequest>("InvalidRequest")({
  error: Schema.Literal("invalid_request"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 400 }) {}

export class NotFound extends Schema.Error<NotFound>("NotFound")({
  error: Schema.Literal("not_found"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 404 }) {}

/** Another turn is in flight for this session. Nothing was executed. */
export class SessionBusy extends Schema.Error<SessionBusy>("SessionBusy")({
  error: Schema.Literal("session_busy"),
  message: Schema.String,
  retryable: Schema.Literal(true)
}, { httpApiStatus: 409 }) {}

export class PayloadTooLarge extends Schema.Error<PayloadTooLarge>("PayloadTooLarge")({
  error: Schema.Literal("payload_too_large"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 413 }) {}

export class UnsupportedMediaType extends Schema.Error<UnsupportedMediaType>("UnsupportedMediaType")({
  error: Schema.Literal("unsupported_media_type"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 415 }) {}

/** The `Idempotency-Key` was already used with a different payload. */
export class IdempotencyConflict extends Schema.Error<IdempotencyConflict>("IdempotencyConflict")({
  error: Schema.Literal("idempotency_conflict"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 422 }) {}

export class InternalError extends Schema.Error<InternalError>("InternalError")({
  error: Schema.Literal("internal_error"),
  message: Schema.String,
  retryable: Schema.Literal(true)
}, { httpApiStatus: 500 }) {}

/** The backend or agent doesn't support this operation (e.g. compaction). */
export class NotSupported extends Schema.Error<NotSupported>("NotSupported")({
  error: Schema.Literal("not_supported"),
  message: Schema.String,
  retryable: Schema.Literal(false)
}, { httpApiStatus: 501 }) {}

/** The transcription provider failed. Nothing was sent to the agent. */
export class TranscriptionFailed extends Schema.Error<TranscriptionFailed>("TranscriptionFailed")({
  error: Schema.Literal("transcription_failed"),
  message: Schema.String,
  retryable: Schema.Literal(true)
}, { httpApiStatus: 502 }) {}

/** No runner is connected. Nothing was executed and nothing is queued. */
export class AgentOffline extends Schema.Error<AgentOffline>("AgentOffline")({
  error: Schema.Literal("agent_offline"),
  message: Schema.String,
  retryable: Schema.Literal(true)
}, { httpApiStatus: 503 }) {}

export const ErrorCode = Schema.Literals([
  "unauthorized",
  "invalid_request",
  "not_found",
  "session_busy",
  "payload_too_large",
  "unsupported_media_type",
  "idempotency_conflict",
  "internal_error",
  "not_supported",
  "transcription_failed",
  "agent_offline"
])
export type ErrorCode = typeof ErrorCode.Type

/** Any error response, for clients that just need to read `error` / `retryable`. */
export const ErrorResponse = Schema.Union([
  Unauthorized,
  InvalidRequest,
  NotFound,
  SessionBusy,
  PayloadTooLarge,
  UnsupportedMediaType,
  IdempotencyConflict,
  InternalError,
  NotSupported,
  TranscriptionFailed,
  AgentOffline
])
export type ErrorResponse = typeof ErrorResponse.Type
