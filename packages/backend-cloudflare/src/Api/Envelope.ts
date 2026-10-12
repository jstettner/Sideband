/**
 * The HttpApi builder answers malformed requests itself (wrong content type, missing header, bad query)
 * with plain-text or empty bodies, and v4 has no hook to shape them. Re-wrap those in the protocol's error
 * shape so clients can always read `error` and `retryable`.
 */
import { Effect, Match } from "effect"
import { HttpBody, HttpServerError, HttpServerResponse } from "effect/http"

const decoder = new TextDecoder()

export const envelope = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse => {
  const code = Match.value(response.status).pipe(
    Match.when(415, () => "unsupported_media_type" as const),
    Match.when(400, () => "invalid_request" as const),
    Match.orElse(() => undefined)
  )

  const bytes = response.body instanceof HttpBody.Uint8Array ? response.body : undefined
  const contentType = bytes?.contentType ?? response.headers["content-type"] ?? ""

  if (code === undefined || contentType.includes("application/json")) return response

  const body = bytes ? decoder.decode(bytes.body).trim() : ""

  const message = body !== ""
    ? body
    : code === "invalid_request"
    ? "malformed request"
    : "unsupported content type"

  return HttpServerResponse.jsonUnsafe({ error: code, message, retryable: false }, { status: response.status })
}

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
    Effect.map(envelope)
  )
