import { describe, expect, it } from "@effect/vitest"
import { Api } from "@sideband/protocol"
import type { Transcription } from "@sideband/transcription"
import * as FakeTranscription from "@sideband/transcription/testing"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Auth from "../src/Api/Auth.ts"
import * as Status from "../src/Api/Status.ts"
import * as Turns from "../src/Api/Turns.ts"
import type { SubmitTurn } from "../src/Relay/Lifecycle.ts"
import { RelayClient } from "../src/Relay/RelayClient.ts"

const KEY = "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f"

/** 16 kHz mono PCM16 with an Apple-style padding chunk, which the handler must strip before transcribing. */
const appleWav = () => {
  const bytes = new Uint8Array(12 + 24 + 12 + 8 + 4)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string) => bytes.set([...text].map((c) => c.charCodeAt(0)), at)
  ascii(0, "RIFF")
  view.setUint32(4, bytes.byteLength - 8, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "FLLR")
  view.setUint32(40, 4, true)
  ascii(48, "data")
  view.setUint32(52, 4, true)
  bytes.set([1, 2, 3, 4], 56)

  return bytes
}

/** The turns API over `transcription` and a relay that records what it was handed. */
const api = Effect.fnUntraced(function*(transcription: Layer.Layer<Transcription.Transcription>) {
  const submitted: Array<SubmitTurn> = []

  const relay = Layer.succeed(RelayClient)({
    submit: Effect.fnUntraced(function*(turn) {
      yield* Effect.sync(() => submitted.push(turn))

      return {
        status: "running" as const,
        idempotency_key: turn.key,
        session: turn.session,
        transcript: turn.transcript,
        retry_after_ms: 2000
      }
    }),
    get: Effect.fnUntraced(function*() {
      return yield* Effect.die("unused")
    }),
    status: Effect.fnUntraced(function*() {
      return yield* Effect.die("unused")
    }),
    sessionOp: Effect.fnUntraced(function*() {
      return yield* Effect.die("unused")
    })
  })

  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(Api.SidebandApi).pipe(
          Layer.provide([Turns.layer, Status.layer]),
          Layer.provide([Auth.layer("watch-token"), transcription, relay]),
          Layer.provide(HttpServer.layerServices)
        ),
        { disableLogger: true }
      )
    ),
    ({ dispose }) => Effect.promise(dispose)
  )

  const post = (body: Uint8Array<ArrayBuffer>) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request("http://localhost/v1/turn?session=main", {
          method: "POST",
          headers: { authorization: "Bearer watch-token", "idempotency-key": KEY, "content-type": "audio/wav" },
          body
        })
      )

      return { status: response.status, body: await response.json() }
    })

  return { submitted, post }
})

describe("POST /v1/turn with audio", () => {
  it.effect("transcribes the canonical WAV under the turn's key and relays the transcript", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly audio: Uint8Array; readonly key: string }> = []

      const { submitted, post } = yield* api(
        FakeTranscription.layer((audio, key) =>
          Effect.sync(() => {
            calls.push({ audio, key })

            return { text: "Deploy it.", raw: "deploy it" }
          })
        )
      )

      const response = yield* post(appleWav())

      expect(response.status).toBe(202)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.key).toBe(KEY)
      // The FLLR chunk is gone: the 44-byte canonical header, then the samples.
      expect(calls[0]?.audio.byteLength).toBe(48)
      expect(submitted).toMatchObject([
        { key: KEY, session: "main", transcript: "Deploy it.", transcriptRaw: "deploy it" }
      ])
    }))

  it.effect("a provider failure is a retryable transcription_failed, and no turn is created", () =>
    Effect.gen(function*() {
      const { submitted, post } = yield* api(FakeTranscription.layerFailing("aqua 503"))
      const response = yield* post(appleWav())

      expect(response).toMatchObject({ status: 502, body: { error: "transcription_failed", retryable: true } })
      expect(submitted).toEqual([])
    }))

  it.effect("silence is invalid_request, and no turn is created", () =>
    Effect.gen(function*() {
      const { submitted, post } = yield* api(FakeTranscription.layerTranscript({ text: "  " }))
      const response = yield* post(appleWav())

      expect(response).toMatchObject({ status: 400, body: { error: "invalid_request", message: "no speech detected" } })
      expect(submitted).toEqual([])
    }))

  it.effect("audio that isn't 16 kHz mono PCM16 WAV is unsupported_media_type, and isn't transcribed", () =>
    Effect.gen(function*() {
      const { submitted, post } = yield* api(FakeTranscription.layer(() => Effect.die("transcribed an invalid WAV")))
      const response = yield* post(Uint8Array.from([1, 2, 3, 4]))

      expect(response).toMatchObject({
        status: 415,
        body: { error: "unsupported_media_type", message: "not a RIFF/WAVE file" }
      })
      expect(submitted).toEqual([])
    }))
})
