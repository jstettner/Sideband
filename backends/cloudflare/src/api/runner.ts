import { constantTimeEqual } from "./auth.ts"

export const CONNECT_PATH = "/v1/runner/connect"

/**
 * `GET /v1/runner/connect`: checks the runner token, then hands the WebSocket upgrade to the
 * relay. Not part of the client HttpApi; see protocol/runner.md.
 */
export function connect(request: Request, env: Cloudflare.Env): Promise<Response> | Response {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/iu)?.[1]
  if (!token || env.RUNNER_TOKEN === "" || !constantTimeEqual(token, env.RUNNER_TOKEN)) {
    return Response.json(
      { error: "unauthorized", message: "missing or invalid runner token", retryable: false },
      { status: 401 }
    )
  }
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      { error: "invalid_request", message: "expected a WebSocket upgrade", retryable: false },
      { status: 400 }
    )
  }
  return env.RELAY.getByName("owner").fetch(request)
}
