import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, FileSystem, Redacted } from "effect"
import * as Config from "../src/Config.ts"

const load = (path: string) =>
  Effect.gen(function*() {
    const provider = yield* Config.provider(path)

    return yield* Config.RunnerConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
  })

describe("Config.provider", () => {
  it.effect("the environment wins over the settings file, which fills in the rest", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(
        `${dir}/runner.env`,
        "SIDEBAND_BACKEND_URL=https://file.example\nSIDEBAND_RUNNER_TOKEN=from-file\n"
      )
      const before = process.env["SIDEBAND_BACKEND_URL"]

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env["SIDEBAND_BACKEND_URL"] = "https://env.example"
        }),
        () =>
          Effect.sync(() => {
            if (before === undefined) delete process.env["SIDEBAND_BACKEND_URL"]
            else process.env["SIDEBAND_BACKEND_URL"] = before
          })
      )

      const config = yield* load(`${dir}/runner.env`)

      expect(config.backendUrl.href).toBe("https://env.example/")
      expect(Redacted.value(config.runnerToken)).toBe("from-file")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("without a settings file, only the environment is read", () =>
    Effect.gen(function*() {
      const error = yield* load("/nonexistent/runner.env").pipe(Effect.flip)

      expect(error.message).toContain("SIDEBAND_")
    }).pipe(Effect.provide(NodeServices.layer)))
})
