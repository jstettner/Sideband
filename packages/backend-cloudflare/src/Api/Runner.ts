import { Errors } from "@sideband/protocol"
import type * as Cloudflare from "alchemy/Cloudflare"
import { Effect, type Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { OWNER } from "../Relay/RelayClient.ts"
import type { RelayDO } from "../Relay/RelayDO.ts"
import { matches } from "./Auth.ts"

export const CONNECT_PATH = "/v1/runner/connect"

// Encoding a protocol error built here can only fail if it breaks its own schema: a bug, so a defect.
const unauthorized = HttpServerResponse.schemaJson(Errors.Unauthorized)

const invalid = HttpServerResponse.schemaJson(Errors.InvalidRequest)

/**
 * `GET /v1/runner/connect`: checks the runner token, then hands the WebSocket upgrade to the relay. Not
 * part of the client HttpApi; see protocol/runner.md.
 */
export const route = (relays: Cloudflare.DurableObject<RelayDO>, runnerToken: Redacted.Redacted<string>) =>
  HttpRouter.add(
    "*",
    CONNECT_PATH,
    Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const token = request.headers["authorization"]?.match(/^Bearer (.+)$/iu)?.[1]

      if (token === undefined || !matches(token, runnerToken)) {
        return yield* unauthorized(
          new Errors.Unauthorized({
            error: "unauthorized",
            message: "missing or invalid runner token",
            retryable: false
          }),
          { status: 401 }
        ).pipe(Effect.orDie)
      }

      if (request.method !== "GET" || request.headers["upgrade"]?.toLowerCase() !== "websocket") {
        return yield* invalid(
          new Errors.InvalidRequest({
            error: "invalid_request",
            message: "expected a WebSocket upgrade",
            retryable: false
          }),
          { status: 400 }
        ).pipe(Effect.orDie)
      }

      return yield* relays.getByName(OWNER).fetch(request)
    }).pipe(Effect.withSpan("Runner.connect"))
  )
