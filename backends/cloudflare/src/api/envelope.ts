/**
 * The HttpApi builder answers malformed requests itself (wrong content type, missing header,
 * bad query) with plain-text or empty bodies. Re-wrap those in the protocol's error shape so
 * clients can always read `error` and `retryable`.
 */
export async function envelope(response: Response): Promise<Response> {
  const code = response.status === 415 ? "unsupported_media_type" : response.status === 400 ? "invalid_request" : undefined
  if (!code || response.headers.get("content-type")?.includes("application/json")) return response

  const text = (await response.text()).trim()
  const message = text !== "" ? text : code === "invalid_request" ? "malformed request" : "unsupported content type"
  return Response.json({ error: code, message, retryable: false }, { status: response.status })
}
