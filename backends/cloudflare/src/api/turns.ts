import {
  DEFAULT_SESSION,
  MAX_AUDIO_BYTES,
  NotFound,
  PayloadTooLarge,
  SidebandApi,
  TranscriptionFailed,
  UnsupportedMediaType
} from "@sideband/protocol"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { canonicalWav, InvalidWav } from "../audio/wav.ts"
import { Transcription } from "../transcription/Transcription.ts"

/**
 * Milestone 2: transcribe and answer with the transcript itself. No relay or runner yet, so
 * nothing is stored and `get` never finds a turn.
 */
export const layer = HttpApiBuilder.group(SidebandApi, "turns", Effect.fnUntraced(function*(handlers) {
  const transcription = yield* Transcription
  return handlers
    .handle("submit", ({ payload, query, headers }) =>
      Effect.gen(function*() {
        const key = headers["idempotency-key"]
        const session = query.session ?? DEFAULT_SESSION

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

        return {
          status: "completed" as const,
          idempotency_key: key,
          session,
          transcript,
          ...(transcriptRaw !== undefined ? { transcript_raw: transcriptRaw } : {}),
          watch_text: transcript
        }
      })
    )
    .handle("get", ({ params }) =>
      Effect.fail(
        new NotFound({
          error: "not_found",
          message: `no turn ${params.idempotency_key}`,
          retryable: false
        })
      )
    )
}))
