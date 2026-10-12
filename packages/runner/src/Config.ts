import { Config, ConfigProvider, Effect, FileSystem } from "effect"

/** Runner settings, from {@link provider}. */
export const RunnerConfig = Config.all({
  /** Backend base URL, `https://` or `wss://`; the runner connects to `/v1/runner/connect`. */
  backendUrl: Config.URL("SIDEBAND_BACKEND_URL"),
  runnerToken: Config.Redacted("SIDEBAND_RUNNER_TOKEN")
})

/**
 * Where a running runner reads its settings: the environment first (in the repo, `bun run start` loads
 * `packages/runner/.env` into it), then the `KEY=value` file at `path`, if there is one.
 */
export const provider = Effect.fn("Config.provider")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const env = ConfigProvider.fromEnv()

  if (!(yield* fs.exists(path))) return env

  return ConfigProvider.orElse(env, yield* ConfigProvider.fromDotEnv({ path }))
})
