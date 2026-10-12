import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Agent } from "./agent/Agent.ts"
import * as HermesAgent from "./agent/HermesAgent.ts"
import { HermesClient } from "./agent/HermesClient.ts"
import { RunnerConfig } from "./config.ts"
import * as Connection from "./connection/Connection.ts"
import { Executor } from "./turns/Executor.ts"

/** The agent adapter selected by `SIDEBAND_AGENT`. */
const AgentLayer = Layer.unwrap(
  Effect.gen(function*() {
    const { agent } = yield* RunnerConfig
    switch (agent) {
      case "echo":
        return Agent.layerEcho
      case "hermes":
        return HermesAgent.layer.pipe(
          Layer.provide(HermesClient.layer),
          Layer.provide(FetchHttpClient.layer)
        )
    }
  })
)

const MainLayer = Executor.layer.pipe(Layer.provideMerge(AgentLayer))

Connection.run.pipe(
  Effect.provide(MainLayer),
  BunRuntime.runMain
)
