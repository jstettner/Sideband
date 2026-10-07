import {
  InvalidRequest,
  MAX_AUDIO_BYTES,
  PayloadTooLarge,
  SidebandApi,
  TranscriptionFailed,
  UnsupportedMediaType
} from "@sideband/protocol"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { canonicalWav, InvalidWav } from "../audio/wav.ts"
import { RelayClient } from "../relay/RelayClient.ts"
import { Transcription } from "../transcription/Transcription.ts"

/**
 * SHA-256 of the request body. The relay stores it with the key, so a retry with the same key
 * but a different body is refused (`idempotency_conflict`) rather than answered with another
 * command's result.
 */
const payloadHash = (payload: Uint8Array | { readonly text: string }) =>
  Effect.promise(async () => {
    const bytes = "text" in payload ? new TextEncoder().encode(`text:${payload.text}`) : payload
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  })

/**
 * Transcribes (unless the client sent text), then hands the turn to the relay. Transcription
 * comes before the relay's idempotency claim: it has no side effects, so a retry costs at most
 * one more provider call.
 */
export const layer = HttpApiBuilder.group(SidebandApi, "turns", Effect.fnUntraced(function*(handlers) {
  const transcription = yield* Transcription
  const relay = yield* RelayClient
  return handlers
    .handle("submit", ({ payload, query, headers }) =>
      Effect.gen(function*() {
        const key = headers["idempotency-key"]
        const session = query.session

        let transcript: string
        let transcriptRaw: string | undefined
        if (!("text" in payload)) {
          if (payload.byteLength > MAX_AUDIO_BYTES) {
            return yield* new PayloadTooLarge({
              error: "payload_too_large",
              message: `audio is ${payload.byteLength} bytes; the limit is ${MAX_AUDIO_BYTES}`,
              retryable: false
            })
          }
          const audio = yield* Effect.try({
            try: () => canonicalWav(payload),
            catch: (cause) =>
              new UnsupportedMediaType({
                error: "unsupported_media_type",
                message: cause instanceof InvalidWav ? cause.message : "unreadable WAV",
                retryable: false
              })
          })
          const result = yield* transcription.transcribe(audio, key).pipe(
            Effect.tapError((e) => Effect.logWarning(e.message)),
            Effect.mapError(() =>
              new TranscriptionFailed({
                error: "transcription_failed",
                message: "transcription provider failed",
                retryable: true
              })
            )
          )
          transcript = result.text
          transcriptRaw = result.raw
        } else {
          transcript = payload.text
        }

        // Silence or noise: nothing to send, so no turn is created.
        if (transcript.trim() === "") {
          return yield* new InvalidRequest({
            error: "invalid_request",
            message: "no speech detected",
            retryable: false
          })
        }

        return yield* relay.submit({
          key,
          session,
          transcript,
          transcriptRaw,
          payloadHash: yield* payloadHash(payload)
        })
      })
    )
    .handle("get", ({ params }) => relay.get(params.idempotency_key))
}))
