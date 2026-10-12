/**
 * The contract every `Agent` adapter passes, and an in-memory Hermes API server, so the Hermes adapter
 * is tested without Hermes.
 */
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpBody, HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { Agent } from "../Agent/Agent.ts"
import * as HermesAgent from "../Hermes/HermesAgent.ts"
import * as HermesClient from "../Hermes/HermesClient.ts"

let turns = 0

/** A turn key no earlier test used, so suites that share an agent don't see each other's turns. */
const freshKey = () => `contract-turn-${String(++turns).padStart(8, "0")}`

/**
 * Registers the `Agent` contract tests against `agent` (protocol/runner.md). The layer is built once
 * for the suite, so each test uses its own turn keys.
 */
export const agentContract = (name: string, agent: Layer.Layer<Agent, unknown>): void =>
  layer(agent)(`Agent contract: ${name}`, (it) => {
    it.effect("a re-sent key gets the original turn's outcome", () =>
      Effect.gen(function*() {
        const { runTurn } = yield* Agent
        const turn = { key: freshKey(), transcript: "What's on my calendar?" }
        const first = yield* runTurn(turn)

        expect(yield* runTurn(turn)).toEqual(first)
      }))

    it.effect("each new session is a fresh one", () =>
      Effect.gen(function*() {
        const { sessionOp } = yield* Agent
        const first = yield* sessionOp("new")
        const second = yield* sessionOp("new", first.agentSessionId)

        expect(second.agentSessionId).not.toBe(first.agentSessionId)
      }))

    it.effect("compacting succeeds or fails with NotSupported, never otherwise", () =>
      Effect.gen(function*() {
        const { sessionOp } = yield* Agent
        const { agentSessionId } = yield* sessionOp("new")

        yield* sessionOp("compact", agentSessionId).pipe(
          Effect.asVoid,
          Effect.catchTag("NotSupported", () => Effect.void)
        )
      }))

    it.effect("steering a turn that isn't running delivers nothing", () =>
      Effect.gen(function*() {
        const { steerTurn } = yield* Agent

        expect(yield* steerTurn({ key: freshKey(), transcript: "and tomorrow?" })).toBe("NotRunning")
      }))
  })

/** How the runs a {@link HermesApi} creates go. */
export interface HermesScript {
  /** The status a run settles in. Default: completed, answering with its input. */
  readonly settle?: (input: string, sessionId: string) => HermesClient.SettledRun
  /** `GET /v1/runs/{id}` answers `running` this many times before the settled status. Default 0. */
  readonly pendingReads?: number
  /** `GET /v1/runs/{id}/events` answers `404`, as when an earlier reader took the run's stream. */
  readonly eventsLost?: boolean
  /** `POST /v1/runs` answers `503` this many times before creating the run, as a restarting gateway does. */
  readonly createUnavailable?: number
}

/** An in-memory Hermes API server (`/v1/runs` and `/api/sessions`), behind an `HttpClient`. */
export interface HermesApi {
  readonly client: HttpClient.HttpClient
  /** Every request served, as `METHOD /path`, in order. */
  readonly requests: ReadonlyArray<string>
  /** Runs created. A replayed `Idempotency-Key` creates none. */
  readonly runsCreated: () => number
}

const CreateRun = Schema.fromJsonString(Schema.Struct({
  input: Schema.String,
  instructions: Schema.String,
  session_id: Schema.optionalKey(Schema.String)
}))

/** The event Hermes emits when a run reaches each settled status. */
const settlingEvent = {
  completed: "run.completed",
  waiting_for_approval: "approval.request",
  failed: "run.failed",
  interrupted: "run.failed",
  cancelled: "run.cancelled"
} satisfies Record<HermesClient.SettledRun["status"], string>

const json = (request: HttpClientRequest.HttpClientRequest, status: number, body: Schema.Json | HermesClient.Run) =>
  HttpClientResponse.fromWeb(request, Response.json(body, { status }))

const notFound = (request: HttpClientRequest.HttpClientRequest) =>
  json(request, 404, { error: { message: "not found", code: null } })

export const makeHermesApi = (script: HermesScript = {}): HermesApi => {
  const requests: Array<string> = []
  const runs = new Map<string, { readonly settled: HermesClient.SettledRun; reads: number }>()
  const runByKey = new Map<string, string>()
  let sessions = 0
  let unavailable = script.createUnavailable ?? 0

  const settle = script.settle ??
    ((input, sessionId) => ({ status: "completed", session_id: sessionId, output: input }))

  const pending = (run: { readonly reads: number }) => run.reads < (script.pendingReads ?? 0)

  const createRun = (request: HttpClientRequest.HttpClientRequest) => {
    if (unavailable > 0) {
      unavailable--

      return json(request, 503, { error: { message: "gateway restarting", code: null } })
    }

    const key = request.headers["idempotency-key"] ?? ""
    const replayed = runByKey.get(key)

    if (replayed !== undefined) return json(request, 202, { run_id: replayed, replayed: true })

    const body = Schema.decodeSync(CreateRun)(
      request.body instanceof HttpBody.Uint8Array ? new TextDecoder().decode(request.body.body) : ""
    )

    const runId = `run-${runs.size + 1}`
    runs.set(runId, { settled: settle(body.input, body.session_id ?? runId), reads: 0 })
    runByKey.set(key, runId)

    return json(request, 202, { run_id: runId, replayed: false })
  }

  const serve = (request: HttpClientRequest.HttpClientRequest, url: URL) => {
    requests.push(`${request.method} ${url.pathname}`)

    if (request.method === "POST" && url.pathname === "/v1/runs") return createRun(request)

    if (request.method === "POST" && url.pathname === "/api/sessions") {
      return json(request, 201, { session: { id: `session-${++sessions}` } })
    }

    const [, v1, resource, runId = "", action] = url.pathname.split("/")
    const run = runs.get(runId)

    if (v1 !== "v1" || resource !== "runs" || run === undefined) return notFound(request)

    if (request.method === "GET" && action === undefined) {
      const answer: HermesClient.Run = pending(run)
        ? { status: "running", session_id: run.settled.session_id }
        : run.settled

      run.reads++

      return json(request, 200, answer)
    }

    if (request.method === "GET" && action === "events") {
      if (script.eventsLost) return notFound(request)

      const events = ["run.started", settlingEvent[run.settled.status]]

      return HttpClientResponse.fromWeb(
        request,
        new Response(events.map((event) => `data: ${JSON.stringify({ event })}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" }
        })
      )
    }

    if (request.method === "POST" && action === "steer") {
      return pending(run)
        ? json(request, 200, { accepted: true })
        : json(request, 409, { error: { message: "run is not running", code: "not_running" } })
    }

    return notFound(request)
  }

  return {
    client: HttpClient.make((request, url) => Effect.sync(() => serve(request, url))),
    requests,
    runsCreated: () => runs.size
  }
}

/** The Hermes adapter, talking to `api`. */
export const layerHermes = (api: HermesApi): Layer.Layer<Agent> =>
  HermesAgent.layer.pipe(
    Layer.provide(HermesClient.layer({ apiUrl: new URL("http://hermes.test"), apiKey: Redacted.make("hermes-key") })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient)(api.client))
  )
