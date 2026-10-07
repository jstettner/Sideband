import { Context, Data, Effect, Layer, Option, Redacted, Schedule, Schema, Stream } from "effect"
import * as Sse from "effect/encoding/Sse"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { HermesConfig } from "../config.ts"

/**
 * Transient failures (network, 429, 5xx) are retried this many times with exponential backoff
 * (0.5 s, 1 s, … ≈ 30 s in total), enough to ride out a gateway restart. `POST /v1/runs` is safe
 * to retry because of its `Idempotency-Key`.
 */
const RETRY_TIMES = 6
const RETRY_BASE = "500 millis"

/** A Hermes API call failed, or answered something we couldn't decode. */
export class HermesError extends Data.TaggedError("HermesError")<{
  readonly message: string
}> {}

/** A run that is still going. */
const PendingRun = Schema.Struct({ status: Schema.Literals(["queued", "running", "stopping"]), session_id: Schema.String })

/** A run that won't change any more unless someone acts on it (an approval, a stop). */
export const SettledRun = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("waiting_for_approval"),
    session_id: Schema.String,
    approval: Schema.Struct({ description: Schema.String, command: Schema.optional(Schema.String) })
  }),
  Schema.Struct({ status: Schema.Literal("completed"), session_id: Schema.String, output: Schema.String }),
  Schema.Struct({ status: Schema.Literals(["failed", "interrupted"]), session_id: Schema.String, error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled"), session_id: Schema.String })
])
export type SettledRun = typeof SettledRun.Type

/**
 * `GET /v1/runs/{id}` (gateway/platforms/api_server_runs.py, Hermes v0.21.1). `session_id` is the
 * session the run actually used: Hermes resolves a session rotated by compaction to its live tip.
 */
export const Run = Schema.Union([PendingRun, SettledRun])
export type Run = typeof Run.Type

export const isSettled = (run: Run): run is SettledRun =>
  run.status !== "queued" && run.status !== "running" && run.status !== "stopping"

/** `202` from `POST /v1/runs`, for a new run and for a replay of the same `Idempotency-Key`. */
const RunAccepted = Schema.Struct({ run_id: Schema.String, replayed: Schema.Boolean })

/** `201` from `POST /api/sessions`. */
const SessionCreated = Schema.Struct({ session: Schema.Struct({ id: Schema.String }) })

/** One frame of `GET /v1/runs/{id}/events`: JSON in `data`, the event name inside it. */
const RunEvent = Schema.Struct({ event: Schema.String })

/** OpenAI-style error envelope Hermes uses for non-2xx answers. */
const ErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.String, code: Schema.optional(Schema.NullOr(Schema.String)) })
})

/** The parts of the Hermes API server the runner uses. */
export class HermesClient extends Context.Service<HermesClient, {
  /**
   * Starts a run. `key` is the `Idempotency-Key`: Hermes keeps it for 24 h and answers a retry with
   * the original run, or `409 idempotency_key_conflict` if the payload differs.
   */
  readonly createRun: (run: {
    readonly key: string
    readonly input: string
    readonly instructions: string
    /** Omitted for a new session; Hermes then uses the run ID as the session ID. */
    readonly sessionId?: string | undefined
  }) => Effect.Effect<{ readonly runId: string; readonly replayed: boolean }, HermesError>
  readonly getRun: (runId: string) => Effect.Effect<Run, HermesError>
  /**
   * Names of the run's events as they happen (`message.delta`, `tool.started`, `approval.request`,
   * `run.completed`, …). Ends when the run finishes. Hermes keeps one in-memory stream per run and
   * drops it when its reader disconnects, so this fails with `404` if the stream is gone.
   */
  readonly runEvents: (runId: string) => Stream.Stream<string, HermesError>
  /** Creates an empty session and returns its ID. */
  readonly createSession: Effect.Effect<string, HermesError>
}>()("sideband/runner/agent/HermesClient") {
  static readonly layer = Layer.effect(
    HermesClient,
    Effect.gen(function*() {
      const config = yield* HermesConfig
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(config.apiUrl.toString()),
            HttpClientRequest.bearerToken(Redacted.value(config.apiKey))
          )
        ),
        HttpClient.retryTransient({ times: RETRY_TIMES, schedule: Schedule.exponential(RETRY_BASE) })
      )

      /** Executes `request`; a non-2xx answer becomes a `HermesError` with Hermes's error message. */
      const execute = (what: string, request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function*() {
          const response = yield* client.execute(request)
          if (response.status >= 200 && response.status < 300) return response
          const body = yield* HttpClientResponse.schemaBodyJson(ErrorBody)(response).pipe(Effect.option)
          const detail = Option.match(body, {
            onNone: () => "",
            onSome: ({ error }) => `${error.code ? ` ${error.code}` : ""}: ${error.message}`
          })
          return yield* new HermesError({ message: `${what}: ${response.status}${detail}` })
        }).pipe(
          Effect.catchTag("HttpClientError", (e) => Effect.fail(new HermesError({ message: `${what}: ${e.message}` })))
        )

      const call = <S extends Schema.Constraint>(what: string, request: HttpClientRequest.HttpClientRequest, schema: S) =>
        execute(what, request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.catchTags({
            HttpClientError: (e) => Effect.fail(new HermesError({ message: `${what}: ${e.message}` })),
            SchemaError: (e) => Effect.fail(new HermesError({ message: `${what}: unexpected answer: ${e.message}` }))
          })
        )

      return HermesClient.of({
        createRun: ({ key, input, instructions, sessionId }) =>
          call(
            "POST /v1/runs",
            HttpClientRequest.post("/v1/runs").pipe(
              HttpClientRequest.setHeader("idempotency-key", key),
              HttpClientRequest.bodyJsonUnsafe({
                input,
                instructions,
                ...(sessionId !== undefined ? { session_id: sessionId } : {})
              })
            ),
            RunAccepted
          ).pipe(Effect.map((run) => ({ runId: run.run_id, replayed: run.replayed }))),
        getRun: (runId) =>
          call(`GET /v1/runs/${runId}`, HttpClientRequest.get(`/v1/runs/${encodeURIComponent(runId)}`), Run),
        runEvents: (runId) => {
          const what = `GET /v1/runs/${runId}/events`
          return HttpClientResponse.stream(
            execute(what, HttpClientRequest.get(`/v1/runs/${encodeURIComponent(runId)}/events`))
          ).pipe(
            Stream.decodeText,
            Stream.pipeThroughChannel(Sse.decodeDataSchema(RunEvent)),
            Stream.map((frame) => frame.data.event),
            Stream.mapError((e) =>
              e._tag === "HermesError" ? e : new HermesError({ message: `${what}: ${"message" in e ? e.message : e._tag}` })
            )
          )
        },
        createSession: call(
          "POST /api/sessions",
          HttpClientRequest.post("/api/sessions").pipe(HttpClientRequest.bodyJsonUnsafe({})),
          SessionCreated
        ).pipe(Effect.map((created) => created.session.id))
      })
    })
  )
}
