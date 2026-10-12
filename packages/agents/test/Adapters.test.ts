import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Record } from "effect"
import { HttpClient } from "effect/http"
import { Adapters } from "../src/index.ts"

const unusedClient = Layer.succeed(HttpClient.HttpClient)(HttpClient.make(() => Effect.die("no request expected")))

describe("Adapters", () => {
  for (const adapter of Record.keys(Adapters.adapters)) {
    it.effect(`SIDEBAND_AGENT=${adapter} selects it`, () =>
      Effect.gen(function*() {
        expect(yield* Adapters.config.parse(ConfigProvider.fromUnknown({ SIDEBAND_AGENT: adapter }))).toBe(adapter)
      }))
  }

  it.effect("an adapter that isn't in the record fails configuration", () =>
    Effect.gen(function*() {
      const error = yield* Layer.build(Adapters.layer.pipe(Layer.provide(unusedClient))).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ SIDEBAND_AGENT: "nobody" })),
        Effect.scoped,
        Effect.flip
      )

      expect(error.message).toMatch(/SIDEBAND_AGENT/)
    }))
})
