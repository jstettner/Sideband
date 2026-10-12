import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Record } from "effect"
import { HttpClient } from "effect/http"
import { Providers } from "../src/index.ts"

const unusedClient = Layer.succeed(HttpClient.HttpClient)(HttpClient.make(() => Effect.die("no request expected")))

describe("Providers", () => {
  for (const provider of Record.keys(Providers.providers)) {
    it.effect(`SIDEBAND_TRANSCRIPTION=${provider} selects it`, () =>
      Effect.gen(function*() {
        expect(yield* Providers.config.parse(ConfigProvider.fromUnknown({ SIDEBAND_TRANSCRIPTION: provider }))).toBe(
          provider
        )
      }))
  }

  it.effect("a provider that isn't in the record fails configuration", () =>
    Effect.gen(function*() {
      const error = yield* Layer.build(Providers.layer.pipe(Layer.provide(unusedClient))).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ SIDEBAND_TRANSCRIPTION: "not-a-provider" })
        ),
        Effect.scoped,
        Effect.flip
      )

      expect(error.message).toMatch(/SIDEBAND_TRANSCRIPTION/)
    }))
})
