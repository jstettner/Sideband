/**
 * The agent adapters a runner can choose: the one place each is named. Adding an adapter is a module
 * for it plus one entry here.
 */
import { Config, Effect, Layer, Record } from "effect"
import * as Echo from "./Echo/Echo.ts"
import * as HermesAgent from "./Hermes/HermesAgent.ts"
import * as HermesClient from "./Hermes/HermesClient.ts"

/** Each adapter's `Agent` layer, reading its own settings from the host's environment. */
export const adapters = {
  echo: Echo.layerConfig,
  hermes: HermesAgent.layer.pipe(Layer.provide(HermesClient.layerConfig))
}

/** `SIDEBAND_AGENT`: a key of {@link adapters}, `echo` when unset. */
export const config = Config.Literals(Record.keys(adapters), "SIDEBAND_AGENT").pipe(
  Config.withDefault("echo" as const)
)

/** The adapter {@link config} selects. Only that adapter's settings are read. */
export const layer = Layer.unwrap(Effect.gen(function*() {
  return adapters[yield* config]
}))
