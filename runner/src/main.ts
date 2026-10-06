import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"

const program = Effect.log("sideband runner starting")

BunRuntime.runMain(program)
