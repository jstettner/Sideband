import { Api } from "@sideband/protocol"
import { Providers } from "@sideband/transcription"
import { env } from "cloudflare:workers"
import { ConfigProvider, Layer } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Auth from "./Api/Auth.ts"
import { envelope } from "./Api/Envelope.ts"
import * as Runner from "./Api/Runner.ts"
import * as Status from "./Api/Status.ts"
import * as Turns from "./Api/Turns.ts"
import { RelayClient } from "./Relay/RelayClient.ts"

export { Relay } from "./Relay/Relay.ts"

const ApiLive = HttpApiBuilder.layer(Api.SidebandApi).pipe(
  Layer.provide([Turns.layer, Status.layer]),
  Layer.provide([
    Auth.layer(env.WATCH_TOKEN),
    Providers.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    RelayClient.layer(env.RELAY)
  ]),
  Layer.provide(HttpServer.layerServices),
  // Providers read their settings (`SIDEBAND_TRANSCRIPTION`, `AQUA_API_KEY`) from the Worker's vars and secrets.
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
)

// Built once per isolate; layers are constructed on the first request.
const { handler } = HttpRouter.toWebHandler(ApiLive)

export default {
  fetch: async (request, bindings) =>
    new URL(request.url).pathname === Runner.CONNECT_PATH
      ? Runner.connect(request, bindings)
      : envelope(await handler(request))
} satisfies ExportedHandler<Cloudflare.Env>
