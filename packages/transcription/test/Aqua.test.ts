import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { HttpBody, HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { Aqua, Transcription } from "../src/index.ts"

const KEY = "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f"

const audio = Uint8Array.from([1, 2, 3, 4])

/** Aqua over a scripted `HttpClient` that answers every request with `answer` and records it. */
const aqua = (answer: () => Response) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request)

      return HttpClientResponse.fromWeb(request, answer())
    })
  )

  const layer = Aqua.layer({ apiKey: Redacted.make("aqua-key") }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient)(client))
  )

  return { requests, layer }
}

const transcribe = Transcription.Transcription.use((t) => t.transcribe(audio, KEY))

describe("Aqua", () => {
  it.effect("posts the audio as the `audio` part, with the API key and the turn's idempotency key", () => {
    const { requests, layer } = aqua(() => Response.json({ raw_text: "hi", text: "hi" }))

    return Effect.gen(function*() {
      yield* transcribe
      const [request] = requests

      expect(request?.method).toBe("POST")
      expect(request?.url).toBe("https://api.aquavoice.com/v1/dictations")
      expect(request?.headers["authorization"]).toBe("Bearer aqua-key")
      expect(request?.headers["idempotency-key"]).toBe(KEY)

      const part = request?.body instanceof HttpBody.FormData ? request.body.formData.get("audio") : null
      assert.instanceOf(part, Blob)

      expect(new Uint8Array(yield* Effect.promise(() => part.arrayBuffer()))).toEqual(audio)
    }).pipe(Effect.provide(layer))
  })

  it.effect("trims the text and keeps `raw` only when it differs", () =>
    Effect.gen(function*() {
      const same = yield* transcribe.pipe(
        Effect.provide(aqua(() => Response.json({ raw_text: "Hello.", text: " Hello.\n" })).layer)
      )

      const changed = yield* transcribe.pipe(
        Effect.provide(aqua(() => Response.json({ raw_text: "hello period", text: "Hello." })).layer)
      )

      expect(same).toEqual({ text: "Hello." })
      expect(changed).toEqual({ text: "Hello.", raw: "hello period" })
    }))

  it.effect("surfaces Aqua's error code and message", () =>
    Effect.gen(function*() {
      const error = yield* transcribe.pipe(
        Effect.provide(
          aqua(() => Response.json({ error: { code: "rate_limited", message: "slow down" } }, { status: 429 })).layer
        ),
        Effect.flip
      )

      expect(error).toBeInstanceOf(Transcription.TranscriptionError)
      expect(error.message).toBe("aqua 429 rate_limited: slow down")
    }))

  it.effect("fails with the status when the error body isn't Aqua's", () =>
    Effect.gen(function*() {
      const error = yield* transcribe.pipe(
        Effect.provide(aqua(() => new Response("Bad Gateway", { status: 502 })).layer),
        Effect.flip
      )

      expect(error.message).toBe("aqua 502")
    }))

  it.effect("fails on an answer that isn't a dictation", () =>
    Effect.gen(function*() {
      const error = yield* transcribe.pipe(
        Effect.provide(aqua(() => Response.json({ transcript: "hi" })).layer),
        Effect.flip
      )

      expect(error).toBeInstanceOf(Transcription.TranscriptionError)
      expect(error.message).toMatch(/^aqua: unexpected answer/)
    }))
})
