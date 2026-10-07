import { Effect, Layer } from "effect"
import { Transcription, TranscriptionError } from "./Transcription.ts"

const ENDPOINT = "https://api.aquavoice.com/v1/dictations"

interface DictationResult {
  readonly raw_text: string
  readonly text: string
}

interface AquaError {
  readonly error?: { readonly code?: string; readonly message?: string }
}

/**
 * Aqua's dictation pipeline: Avalon speech recognition plus the account's dictionary,
 * replacements, and custom instructions. Same output as the Aqua app.
 */
export const layer = (apiKey: string) =>
  Layer.succeed(Transcription)({
    transcribe: (audio, idempotencyKey) =>
      Effect.tryPromise({
        try: async () => {
          const form = new FormData()
          form.append("audio", new Blob([audio], { type: "audio/wav" }), "turn.wav")
          const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": idempotencyKey },
            body: form
          })
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as AquaError
            throw new TranscriptionError({
              message: `aqua ${response.status} ${body.error?.code ?? ""}: ${body.error?.message ?? response.statusText}`
            })
          }
          const result = (await response.json()) as DictationResult
          const text = result.text.trim()
          return { text, raw: result.raw_text !== text ? result.raw_text : undefined }
        },
        catch: (cause) =>
          cause instanceof TranscriptionError ? cause : new TranscriptionError({ message: `aqua: ${String(cause)}` })
      })
  })
