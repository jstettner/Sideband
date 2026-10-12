/**
 * Aqua's dictation pipeline: Avalon speech recognition plus the account's dictionary,
 * replacements, and custom instructions. Same output as the Aqua app.
 */
import { Config, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Transcription, TranscriptionError } from "../Transcription/Transcription.ts"

const ENDPOINT = "https://api.aquavoice.com/v1/dictations"

/** What Aqua needs to be called: its API key, from the host's `AQUA_API_KEY`. */
export const config = Config.all({ apiKey: Config.Redacted("AQUA_API_KEY") })

/** `200` from `POST /v1/dictations`. */
const Dictation = Schema.Struct({ raw_text: Schema.String, text: Schema.String })

/** Aqua's error envelope for non-2xx answers. Every field may be missing. */
const ErrorBody = Schema.Struct({
  error: Schema.optionalKey(Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String)
  }))
})

/** A `TranscriptionError` for a non-2xx answer, with Aqua's error code and message when it sent them. */
const failure = Effect.fnUntraced(function*(response: HttpClientResponse.HttpClientResponse) {
  const body = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(Effect.option)
  const error = Option.getOrUndefined(body)?.error
  const code = error?.code !== undefined ? ` ${error.code}` : ""
  const message = error?.message !== undefined ? `: ${error.message}` : ""

  return yield* new TranscriptionError({ message: `aqua ${response.status}${code}${message}` })
})

export const layer = (
  options: Config.Success<typeof config>
): Layer.Layer<Transcription, never, HttpClient.HttpClient> =>
  Layer.effect(
    Transcription,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient

      return Transcription.of({
        transcribe: Effect.fn("Aqua.transcribe")(
          function*(audio, idempotencyKey) {
            const form = new FormData()
            form.append("audio", new Blob([audio], { type: "audio/wav" }), "turn.wav")

            const response = yield* client.execute(
              HttpClientRequest.post(ENDPOINT).pipe(
                HttpClientRequest.bearerToken(options.apiKey),
                HttpClientRequest.setHeader("idempotency-key", idempotencyKey),
                HttpClientRequest.bodyFormData(form)
              )
            )

            if (response.status < 200 || response.status >= 300) return yield* failure(response)

            const dictation = yield* HttpClientResponse.schemaBodyJson(Dictation)(response)
            const text = dictation.text.trim()

            return dictation.raw_text === text ? { text } : { text, raw: dictation.raw_text }
          },
          Effect.catchTags({
            HttpClientError: (e) => Effect.fail(new TranscriptionError({ message: `aqua: ${e.message}` })),
            SchemaError: (e) =>
              Effect.fail(new TranscriptionError({ message: `aqua: unexpected answer: ${e.message}` }))
          })
        )
      })
    })
  )

/** {@link layer} with its {@link config} read from the host's environment. */
export const layerConfig: Layer.Layer<Transcription, Config.ConfigError, HttpClient.HttpClient> = Layer.unwrap(
  Effect.gen(function*() {
    return layer(yield* config)
  })
)
