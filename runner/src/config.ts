import { Config } from "effect"

/** Runner settings, from the environment (`.env` in the working directory; Bun loads it). */
export const RunnerConfig = Config.all({
  /** Backend base URL, `https://` or `wss://`; the runner connects to `/v1/runner/connect`. */
  backendUrl: Config.URL("SIDEBAND_BACKEND_URL"),
  runnerToken: Config.Redacted("SIDEBAND_RUNNER_TOKEN"),
  agent: Config.Literals(["echo", "hermes"], "SIDEBAND_AGENT").pipe(Config.withDefault("echo" as const))
})

/** Hermes API server (`API_SERVER_*` in `~/.hermes/.env`). Only read when `SIDEBAND_AGENT=hermes`. */
export const HermesConfig = Config.all({
  apiUrl: Config.URL("HERMES_API_URL"),
  apiKey: Config.Redacted("HERMES_API_KEY")
})
