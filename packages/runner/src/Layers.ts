import { BunSocket } from "@effect/platform-bun"
import { Adapters } from "@sideband/agents"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Executor } from "./Executor/Executor.ts"

/** The agent adapter `SIDEBAND_AGENT` selects, with the executor running turns against it. */
export const Main = Executor.layer.pipe(
  Layer.provideMerge(Adapters.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provideMerge(BunSocket.layerWebSocketConstructor)
)
