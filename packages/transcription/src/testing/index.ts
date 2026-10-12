import { Effect, Layer } from "effect"
import { type Transcript, Transcription, TranscriptionError } from "../Transcription/Transcription.ts"

/** A `Transcription` that answers every call with `transcribe`, so a test sees what it was called with. */
export const layer = (transcribe: Transcription["Service"]["transcribe"]): Layer.Layer<Transcription> =>
  Layer.succeed(Transcription)({ transcribe })

/** Transcribes everything as `transcript`. */
export const layerTranscript = (transcript: Transcript): Layer.Layer<Transcription> =>
  layer(() => Effect.succeed(transcript))

/** Fails every call, as a provider that is down does. */
export const layerFailing = (message: string): Layer.Layer<Transcription> =>
  layer(() => Effect.fail(new TranscriptionError({ message })))
