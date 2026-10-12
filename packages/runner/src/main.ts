import { BunRuntime } from "@effect/platform-bun"
import { Adapters } from "@sideband/agents"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import * as Connection from "./Connection/Connection.ts"
import { Executor } from "./Turns/Executor.ts"

/** The agent adapter selected by `SIDEBAND_AGENT`. */
const AgentLayer = Adapters.layer.pipe(Layer.provide(FetchHttpClient.layer))

const MainLayer = Executor.layer.pipe(Layer.provideMerge(AgentLayer))

Connection.run.pipe(
  Effect.provide(MainLayer),
  BunRuntime.runMain
)
