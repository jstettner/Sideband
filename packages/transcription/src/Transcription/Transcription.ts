import { Context, type Effect, Schema } from "effect"

export const Transcript = Schema.Struct({
  /** Final text handed to the agent. */
  text: Schema.String,
  /** Provider's literal output, when it differs from `text` (diagnostics). */
  raw: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "Transcript" })

export type Transcript = typeof Transcript.Type

/** The provider failed or answered something unreadable. Nothing was transcribed. */
export class TranscriptionError extends Schema.TaggedError<TranscriptionError>()("TranscriptionError", {
  message: Schema.String
}) {}

/** Speech to text. Providers are layers; callers only see this. */
export class Transcription extends Context.Service<Transcription, {
  /**
   * `audio` is canonical 16 kHz mono PCM16 WAV (`Wav.canonical`). `idempotencyKey` is the turn's
   * key, so a provider that dedups can avoid billing a retry twice.
   */
  readonly transcribe: (
    audio: Uint8Array<ArrayBuffer>,
    idempotencyKey: string
  ) => Effect.Effect<Transcript, TranscriptionError>
}>()("@sideband/transcription/Transcription") {}
