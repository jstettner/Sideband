import { Context, Data, type Effect } from "effect"

export interface Transcript {
  /** Final text handed to the agent. */
  readonly text: string
  /** Provider's literal output, when it differs from `text` (diagnostics). */
  readonly raw?: string | undefined
}

export class TranscriptionError extends Data.TaggedError("TranscriptionError")<{
  readonly message: string
}> {}

/** Speech to text. Providers are layers; the rest of the backend only sees this. */
export class Transcription extends Context.Service<Transcription, {
  /**
   * `audio` is canonical 16 kHz mono PCM16 WAV. `idempotencyKey` is the turn's key, so a
   * provider that dedups can avoid billing a retry twice.
   */
  readonly transcribe: (
    audio: Uint8Array,
    idempotencyKey: string
  ) => Effect.Effect<Transcript, TranscriptionError>
}>()("sideband/backend-cloudflare/transcription/Transcription") {}
