import { describe, expect, it } from "@effect/vitest"
import { Api, Common } from "@sideband/protocol"
import * as FakeTranscription from "@sideband/transcription/testing"
import { Effect, Layer, Logger, Redacted } from "effect"
import { HttpServer, HttpServerRequest } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Auth from "../src/Api/Auth.ts"
import * as Status from "../src/Api/Status.ts"
import * as Turns from "../src/Api/Turns.ts"
import { RelayClient } from "../src/Relay/RelayClient.ts"
import { serve } from "../src/Sideband/SidebandWorker.ts"

/** A logger that keeps the messages it receives. */
const recording = () => {
  const messages: Array<unknown> = []

  return { messages, layer: Logger.layer([Logger.make((options) => messages.push(options.message))]) }
}

/** A relay whose status logs, as a handler's dependencies do while a request runs. */
const unused = Effect.fnUntraced(function*() {
  return yield* Effect.die("unused")
})

const relay = Layer.succeed(RelayClient)({
  submit: unused,
  get: unused,
  status: Effect.fnUntraced(function*(session) {
    yield* Effect.logInfo("relay status")

    return { agent: { online: true }, session: { name: session, busy: false } }
  }),
  sessionOp: unused
})

describe("serve", () => {
  it.effect("handlers log through the Worker's logger, not the one the router was built under", () =>
    Effect.gen(function*() {
      const bridge = recording()
      const worker = recording()

      const api = HttpApiBuilder.layer(Api.SidebandApi).pipe(
        Layer.provide([Turns.layer, Status.layer]),
        Layer.provide([
          Auth.layer(Redacted.make("watch-token")),
          relay,
          FakeTranscription.layerFailing("unused"),
          HttpServer.layerServices
        ])
      )

      // The Worker's init runs under Alchemy's bridge logger, as the router is built.
      const fetch = yield* serve(api, worker.layer).pipe(Effect.provide(bridge.layer))

      const request = new Request(`http://worker/v1/status?session=${Common.SessionName.make("main")}`, {
        headers: { authorization: "Bearer watch-token" }
      })

      const response = yield* fetch.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request))
      )

      expect(response.status).toBe(200)
      expect(worker.messages.flat()).toContain("relay status")
      expect(bridge.messages.flat()).not.toContain("relay status")
    }).pipe(Effect.scoped))
})
