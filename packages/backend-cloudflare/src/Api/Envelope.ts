/**
 * The HttpApi builder answers malformed requests itself (wrong content type, missing header,
 * bad query) with plain-text or empty bodies. Re-wrap those in the protocol's error shape so
 * clients can always read `error` and `retryable`.
 */
import { Match } from "effect"

export async function envelope(response: Response): Promise<Response> {
  const code = Match.value(response.status).pipe(
    Match.when(415, () => "unsupported_media_type" as const),
    Match.when(400, () => "invalid_request" as const),
    Match.orElse(() => undefined)
  )

  if (!code || response.headers.get("content-type")?.includes("application/json")) return response

  const text = (await response.text()).trim()
  const message = text !== "" ? text : code === "invalid_request" ? "malformed request" : "unsupported content type"

  return Response.json({ error: code, message, retryable: false }, { status: response.status })
}
