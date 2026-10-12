import { SidebandApi } from "@sideband/protocol"
import { env } from "cloudflare:workers"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Auth from "./api/auth.ts"
import { envelope } from "./api/envelope.ts"
import * as Runner from "./api/runner.ts"
import * as Status from "./api/status.ts"
import * as Turns from "./api/turns.ts"
import { RelayClient } from "./relay/RelayClient.ts"
import * as AquaDictation from "./transcription/AquaDictation.ts"

export { Relay } from "./relay/Relay.ts"

const Api = HttpApiBuilder.layer(SidebandApi).pipe(
  Layer.provide([Turns.layer, Status.layer]),
  Layer.provide([
    Auth.layer(env.WATCH_TOKEN),
    AquaDictation.layer(env.AQUA_API_KEY),
    RelayClient.layer(env.RELAY)
  ]),
  Layer.provide(HttpServer.layerServices)
)

// Built once per isolate; layers are constructed on the first request.
const { handler } = HttpRouter.toWebHandler(Api)

export default {
  fetch: async (request, env) =>
    new URL(request.url).pathname === Runner.CONNECT_PATH
      ? Runner.connect(request, env)
      : envelope(await handler(request))
} satisfies ExportedHandler<Cloudflare.Env>
