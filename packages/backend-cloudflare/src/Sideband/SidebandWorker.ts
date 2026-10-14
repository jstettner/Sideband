/**
 * `Sideband`: the Worker. It serves the watch API (`Api.SidebandApi`, behind the watch token), the runner's
 * WebSocket upgrade (`/v1/runner/connect`, behind the runner token), which it hands to the Relay, and
 * `/healthz`. It hosts the `Relay` Durable Object.
 *
 * The class, `SidebandWorker`, is the identifier; its logical id, `"Sideband"`, names the script on local
 * stages, and prod's script is `Stage.PROD_SCRIPT`. The default export is the implementation, which only this
 * Worker's bundle and the stack use.
 */
import { Api } from "@sideband/protocol"
import { Transcription } from "@sideband/transcription"
import * as Cloudflare from "alchemy/Cloudflare"
import { Stack } from "alchemy/Stack"
import { type Config, Config as C, Effect, Exit, Layer, Schema } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Auth from "../Api/Auth.ts"
import * as Envelope from "../Api/Envelope.ts"
import * as Runner from "../Api/Runner.ts"
import * as Status from "../Api/Status.ts"
import * as Turns from "../Api/Turns.ts"
import * as Layers from "../Layers.ts"
import * as RelayClient from "../Relay/RelayClient.ts"
import { RelayDO, RelayDOLive } from "../Relay/RelayDO.ts"
import { PROD, PROD_SCRIPT } from "../Stage.ts"

/**
 * The services the watch API's handlers take from `Layers.ts`, built while the Worker is constructed, so
 * Alchemy binds the configuration they read. Removing one from `Layers.ts` fails `bun run check` here.
 */
const services: Layer.Layer<Transcription.Transcription, Config.ConfigError> = Layers.Transcription

/** `GET /healthz`: whether the Relay answers, with its SQLite migrated. */
const Health = Schema.Struct({ ok: Schema.Boolean, relay: Schema.Literals(["ok", "error"]) })

const health = HttpServerResponse.schemaJson(Health)

/**
 * The Worker's `fetch` over `routes`, logging through `logs` instead of the bridge's outer `consolePretty`
 * (alchemy#1954). HttpApi handlers run in the context their router was built in, so the router is built under
 * `logs` too: providing them around each request alone doesn't reach the handlers.
 */
export const serve = Effect.fnUntraced(function*<E, R>(
  routes: Layer.Layer<never, E, R>,
  logs: Layer.Layer<never>
) {
  const fetch = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provide(logs))

  // The Worker's per-request handler: built here once, run by Alchemy on each request, so it is returned unrun.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Envelope.respond(fetch).pipe(Effect.provide(logs))
})

export class SidebandWorker extends Cloudflare.Worker<SidebandWorker, {}, RelayDO>()("Sideband") {}

/** The Worker's props on `stage`. Only prod names its script; local stages keep Alchemy's generated names. */
export const props = (stage: string) => {
  const common = {
    main: import.meta.url,
    // The newest date the workerd pinned by alchemy@2.0.0-beta.81 supports; local dev refuses later ones.
    compatibility: { date: "2026-09-25" },
    dev: { port: 1337 }
  }

  return stage === PROD ? { ...common, name: PROD_SCRIPT } : common
}

export default SidebandWorker.make(
  Stack.useSync((stack) => props(stack.stage)),
  // Runs once per isolate. Bindings and secrets are yielded here; a binding first read inside `fetch` would
  // bind nothing.
  Effect.gen(function*() {
    // Hosts the Relay (registers it with this Worker's exports and migrations) and binds its namespace.
    const relays = yield* RelayDO
    // Bound as secrets.
    const watchToken = yield* C.Redacted("WATCH_TOKEN")
    const runnerToken = yield* C.Redacted("RUNNER_TOKEN")
    // The service alone, not the init context it came from: that context carries the bridge's logger, which
    // would reach every handler.
    const transcription = yield* Transcription.Transcription

    const api = HttpApiBuilder.layer(Api.SidebandApi).pipe(
      Layer.provide([Turns.layer, Status.layer]),
      Layer.provide([
        Auth.layer(watchToken),
        RelayClient.layer(relays),
        Layer.succeed(Transcription.Transcription)(transcription),
        HttpServer.layerServices
      ])
    )

    const healthz = Effect.gen(function*() {
      const exit = yield* Effect.exit(relays.getByName(RelayClient.OWNER).ping())

      if (Exit.isSuccess(exit)) return yield* health({ ok: true, relay: "ok" }).pipe(Effect.orDie)
      yield* Effect.logError("relay ping failed", exit.cause)

      return yield* health({ ok: false, relay: "error" }, { status: 503 }).pipe(Effect.orDie)
    }).pipe(Effect.withSpan("Sideband.healthz"))

    const fetch = yield* serve(
      Layer.mergeAll(api, Runner.route(relays, runnerToken), HttpRouter.add("GET", "/healthz", healthz)),
      Layers.JsonLogs
    )

    return { fetch }
  }).pipe(Effect.provide(Layer.mergeAll(RelayDOLive, services)))
)
