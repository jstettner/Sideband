/**
 * The composition root: the only place that chooses each service's backend and the logger, for the Worker
 * and the Relay. The relay client and authorization are built from the Worker's bindings and secrets in
 * `Sideband/SidebandWorker.ts`.
 */
import { Providers } from "@sideband/transcription"
import { Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"

/**
 * Structured request logs (alchemy#1954). Alchemy's Worker bridge installs `consolePretty` once per
 * isolate as the outermost context; providing this inner logger layer around each handler replaces it for
 * everything the handler logs. The Worker provides it around its `fetch`, and the Relay around each method
 * and socket handler. Alchemy's own bridge and init-time logs stay pretty.
 */
export const JsonLogs = Logger.layer([Logger.consoleJson])

/**
 * Speech to text: the provider `SIDEBAND_TRANSCRIPTION` selects (default `aqua`), over `fetch`. Its
 * settings are read while the Worker is constructed, so Alchemy binds each (the API key as a secret).
 */
export const Transcription = Providers.layer.pipe(Layer.provide(FetchHttpClient.layer))
