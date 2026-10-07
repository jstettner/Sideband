import { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { ContextUsage, IdempotencyKey, SessionName } from "./common.ts"

/** Maximum accepted audio upload. ~2 minutes of 16 kHz mono PCM16. */
export const MAX_AUDIO_BYTES = 4_000_000

/**
 * Audio turn: the raw recording is the request body. 16 kHz mono 16-bit PCM WAV
 * (`audio/wav`) is the required format; backends may accept more and reply
 * `unsupported_media_type` otherwise. Extra RIFF chunks are allowed.
 */
export const AudioTurnBody = Schema.Uint8Array.pipe(
  HttpApiSchema.asUint8Array({ contentType: "audio/wav" })
)

/** Text turn: the client already transcribed (e.g. on-device speech recognition). */
export const TextTurnBody = Schema.Struct({
  text: Schema.NonEmptyString
})
export type TextTurnBody = typeof TextTurnBody.Type

const TurnFields = {
  idempotency_key: IdempotencyKey,
  session: SessionName,
  /** What the user said, once transcribed. */
  transcript: Schema.optionalKey(Schema.String)
}

/** The agent answered. */
export const TurnCompleted = Schema.Struct({
  status: Schema.tag("completed"),
  ...TurnFields,
  /** Provider's literal transcript, when the provider also normalizes (diagnostics). */
  transcript_raw: Schema.optionalKey(Schema.String),
  /** Short, glanceable answer for the watch. */
  watch_text: Schema.String,
  /** Variant for text-to-speech, when it differs from `watch_text`. */
  speak_text: Schema.optionalKey(Schema.String),
  /** The agent's complete response. Backends may omit it. */
  full_text: Schema.optionalKey(Schema.String),
  /** Agent context-window usage after this turn, when the agent reports it. */
  context: Schema.optionalKey(ContextUsage)
})
export type TurnCompleted = typeof TurnCompleted.Type

/** Accepted and still running. Fetch the outcome with `GET /v1/turns/{idempotency_key}`. */
export const TurnRunning = Schema.Struct({
  status: Schema.tag("running"),
  ...TurnFields,
  retry_after_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}).pipe(HttpApiSchema.status(202))
export type TurnRunning = typeof TurnRunning.Type

/** The agent paused for an approval that can't be given from the watch yet. */
export const TurnNeedsApproval = Schema.Struct({
  status: Schema.tag("needs_approval"),
  ...TurnFields,
  message: Schema.String
})
export type TurnNeedsApproval = typeof TurnNeedsApproval.Type

/**
 * The agent ran the turn and it failed (`agent_failed`), or was stopped part way
 * (`interrupted`, e.g. agent restart). This is a stored outcome: retries return it again.
 */
export const TurnFailed = Schema.Struct({
  status: Schema.tag("failed"),
  ...TurnFields,
  code: Schema.Literals(["agent_failed", "interrupted"]),
  message: Schema.String
})
export type TurnFailed = typeof TurnFailed.Type

/**
 * The runner disconnected and the outcome was lost. The turn may or may not have run.
 * It is not re-sent automatically.
 */
export const TurnUnknown = Schema.Struct({
  status: Schema.tag("unknown"),
  ...TurnFields,
  message: Schema.String
})
export type TurnUnknown = typeof TurnUnknown.Type

/** Every turn outcome, discriminated by `status`. Clients treat unknown statuses as errors. */
export const TurnState = Schema.Union([
  TurnCompleted,
  TurnRunning,
  TurnNeedsApproval,
  TurnFailed,
  TurnUnknown
]).pipe(Schema.toTaggedUnion("status"))
export type TurnState = typeof TurnState.Type
