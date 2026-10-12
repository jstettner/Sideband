/**
 * The HttpApi builder answers malformed requests itself (wrong content type, missing header, bad query)
 * with plain-text or empty bodies, and v4 has no hook to shape them. Re-wrap those in the protocol's error
 * shape so clients can always read `error` and `retryable`.
 */
import { Errors } from "@sideband/protocol"
import { Effect, Match, Schema } from "effect"
import { HttpBody, HttpServerError, HttpServerResponse } from "effect/http"

const decoder = new TextDecoder()

const body = HttpServerResponse.schemaJson(Schema.Union([Errors.InvalidRequest, Errors.UnsupportedMediaType]))

export const envelope = Effect.fnUntraced(function*(response: HttpServerResponse.HttpServerResponse) {
  const bytes = response.body instanceof HttpBody.Uint8Array ? response.body : undefined
  const contentType = bytes?.contentType ?? response.headers["content-type"] ?? ""
  const text = bytes ? decoder.decode(bytes.body).trim() : ""

  const error = Match.value(response.status).pipe(
    Match.when(415, () =>
      new Errors.UnsupportedMediaType({
        error: "unsupported_media_type",
        message: text === "" ? "unsupported content type" : text,
        retryable: false
      })),
    Match.when(400, () =>
      new Errors.InvalidRequest({
        error: "invalid_request",
        message: text === "" ? "malformed request" : text,
        retryable: false
      })),
    Match.orElse(() => undefined)
  )

  if (error === undefined || contentType.includes("application/json")) return response

  return yield* body(error, { status: response.status }).pipe(Effect.orDie)
})

/**
 * `fetch` with every failure turned into the response the server would send (a request that doesn't
 * decode fails rather than answering), then {@link envelope}d. Server errors are logged with their cause.
 */
export const respond = <E, R>(
  fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  fetch.pipe(
    Effect.catchCause((cause) =>
      HttpServerError.causeResponse(cause).pipe(
        Effect.tap(([response]) => response.status >= 500 ? Effect.logError("request failed", cause) : Effect.void),
        Effect.map(([response]) => response)
      )
    ),
    Effect.flatMap(envelope)
  )
