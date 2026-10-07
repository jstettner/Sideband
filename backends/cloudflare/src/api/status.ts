import { SidebandApi } from "@sideband/protocol"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { RelayClient } from "../relay/RelayClient.ts"

const status = HttpApiBuilder.group(SidebandApi, "status", Effect.fnUntraced(function*(handlers) {
  const relay = yield* RelayClient
  return handlers.handle("get", ({ query }) => relay.status(query.session))
}))

const sessions = HttpApiBuilder.group(SidebandApi, "sessions", Effect.fnUntraced(function*(handlers) {
  const relay = yield* RelayClient
  return handlers
    .handle("new", ({ params }) => relay.sessionOp(params.session, "new"))
    .handle("compact", ({ params }) => relay.sessionOp(params.session, "compact"))
}))

export const layer = Layer.mergeAll(status, sessions)
