import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Agent } from "./agent/Agent.ts"
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
    }
  })
)

const MainLayer = Executor.layer.pipe(Layer.provideMerge(AgentLayer))

Connection.run.pipe(
  Effect.provide(MainLayer),
  BunRuntime.runMain
)
