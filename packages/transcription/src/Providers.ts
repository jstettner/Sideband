/**
 * The transcription providers a host can choose: the one place each is named. Adding a provider is a
 * module for it plus one entry here.
 */
import { Config, Effect, Layer, Record } from "effect"
import * as Aqua from "./Aqua/Aqua.ts"

/** Each provider's `Transcription` layer, reading its own settings from the host's environment. */
export const providers = {
  aqua: Aqua.layerConfig
}

/** `SIDEBAND_TRANSCRIPTION`: a key of {@link providers}, `aqua` when unset. */
export const config = Config.Literals(Record.keys(providers), "SIDEBAND_TRANSCRIPTION").pipe(
  Config.withDefault("aqua" as const)
)

/** The provider {@link config} selects. Only that provider's settings are read. */
export const layer = Layer.unwrap(Effect.gen(function*() {
  return providers[yield* config]
}))
