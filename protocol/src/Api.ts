import { Context, Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
  OpenApi
} from "effect/http-api"
import { IdempotencyKey, SessionName } from "./common.ts"
import {
  AgentOffline,
  IdempotencyConflict,
  InternalError,
  InvalidRequest,
  NotFound,
  NotSupported,
  PayloadTooLarge,
  SessionBusy,
  TranscriptionFailed,
  Unauthorized,
  UnsupportedMediaType
} from "./errors.ts"
import { SessionState, Status } from "./status.ts"
import { AudioTurnBody, TextTurnBody, TurnState } from "./turn.ts"

/** The authenticated caller, provided by `Authorization` to every handler. */
export class Principal extends Context.Service<Principal, {
  readonly userId: string
}>()("@sideband/protocol/Principal") {}

/** Bearer token auth on every endpoint. */
export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: Principal
}>()("@sideband/protocol/Authorization", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer }
}) {}

const SessionQuery = { session: Schema.optionalKey(SessionName) }
const SessionParams = { session: SessionName }

/** Errors any authenticated endpoint can return. */
const CommonErrors = [InvalidRequest, InternalError] as const

export class TurnsGroup extends HttpApiGroup.make("turns")
  .add(
    HttpApiEndpoint.post("submit", "/v1/turn", {
      query: SessionQuery,
      headers: { "idempotency-key": IdempotencyKey },
      payload: [AudioTurnBody, TextTurnBody],
      success: TurnState.members,
      error: [
        ...CommonErrors,
        SessionBusy,
        PayloadTooLarge,
        UnsupportedMediaType,
        IdempotencyConflict,
        TranscriptionFailed,
        AgentOffline
      ]
    }).annotate(OpenApi.Description, [
      "Submit one push-to-talk turn: raw `audio/mp4` (AAC) body, or JSON `{ \"text\": ... }`.",
      "`session` defaults to `main`. Retrying with the same `Idempotency-Key` never runs the",
      "turn twice: it returns the stored outcome, or `running` while it is still in flight."
    ].join(" "))
  )
  .add(
    HttpApiEndpoint.get("get", "/v1/turns/:idempotency_key", {
      params: { idempotency_key: IdempotencyKey },
      success: TurnState.members,
      error: [...CommonErrors, NotFound]
    }).annotate(OpenApi.Description, "Fetch the outcome of a turn, typically after a `running` response.")
  )
  .middleware(Authorization)
{}

export class StatusGroup extends HttpApiGroup.make("status")
  .add(
    HttpApiEndpoint.get("get", "/v1/status", {
      query: SessionQuery,
      success: Status,
      error: CommonErrors
    }).annotate(OpenApi.Description, "Agent and session state for widgets. Never contacts the agent.")
  )
  .middleware(Authorization)
{}

export class SessionsGroup extends HttpApiGroup.make("sessions")
  .add(
    HttpApiEndpoint.post("new", "/v1/sessions/:session/new", {
      params: SessionParams,
      success: SessionState,
      error: [...CommonErrors, SessionBusy, AgentOffline]
    }).annotate(OpenApi.Description, "Start a fresh agent session behind this session name.")
  )
  .add(
    HttpApiEndpoint.post("compact", "/v1/sessions/:session/compact", {
      params: SessionParams,
      success: SessionState,
      error: [...CommonErrors, SessionBusy, AgentOffline, NotSupported]
    }).annotate(OpenApi.Description, "Compact the agent session's context.")
  )
  .middleware(Authorization)
{}

export class SidebandApi extends HttpApi.make("sideband")
  .add(TurnsGroup)
  .add(StatusGroup)
  .add(SessionsGroup)
  .annotateMerge(OpenApi.annotations({
    title: "Sideband",
    version: "1",
    description: "HTTP contract between a Sideband client (the watch app) and a Sideband backend. See protocol/README.md.",
    license: { name: "MIT" },
    transform: allowAdditionalProperties
  }))
{}

/**
 * Schema decoding ignores unknown keys, and clients must too (fields are only ever added
 * within /v1), so the spec shouldn't forbid them.
 */
function allowAdditionalProperties(spec: Record<string, any>): Record<string, any> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip)
    if (node === null || typeof node !== "object") return node
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key, value]) => !(key === "additionalProperties" && value === false))
        .map(([key, value]) => [key, strip(value)])
    )
  }
  return strip(spec) as Record<string, any>
}
