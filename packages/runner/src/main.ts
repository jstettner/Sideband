import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import * as Connection from "./Connection/Connection.ts"
import * as Layers from "./Layers.ts"

Connection.run.pipe(Effect.provide(Layers.Main), BunRuntime.runMain)
