/**
 * Deploys the `sideband` stack to local workerd (`Test.make({ dev: true })`) and drives it over HTTP and the
 * runner WebSocket, with the real runner (`Connection.run`) in this process.
 *
 * Always `dev: true`: a `test_*` stage outside dev mode would create real Cloudflare resources, tracked only
 * in this checkout's local state. The stage is `test_<user>`; its state lives in
 * `packages/backend-cloudflare/.alchemy/state/sideband/<stage>/`, and no Cloudflare account is needed.
 *
 * The Worker binds its tokens and the transcription key as secrets, so the stack needs them to deploy. The
 * tests set placeholders and only send text turns: they never call Aqua.
 */
import { NodeSocket } from "@effect/platform-node"
import { expect } from "@effect/vitest"
import { Agent, Echo } from "@sideband/agents"
import { Api } from "@sideband/protocol"
import * as Connection from "@sideband/runner/Connection/Connection"
import { Executor } from "@sideband/runner/Executor/Executor"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Test from "alchemy/Test/Vitest"
import { ConfigProvider, Effect, Exit, Fiber, Latch, Layer, Schedule, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { OpenApi } from "effect/http-api"
import * as Socket from "effect/socket/Socket"
import Stack from "../alchemy.run.ts"
import { CONNECT_PATH } from "../src/Api/Runner.ts"

const WATCH_TOKEN = "watch-token-for-tests"

const RUNNER_TOKEN = "runner-token-for-tests"

// Before the stack reads its config when it deploys.
Object.assign(process.env, { WATCH_TOKEN, RUNNER_TOKEN, AQUA_API_KEY: "aqua-placeholder" })

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: Cloudflare.providers(), dev: true })

const stack = beforeAll(deploy(Stack))

/** The Worker's local URL. */
const workerUrl = Effect.flatMap(
  stack,
  ({ url }) => url === undefined ? Effect.die("the stack has no Worker URL") : Effect.succeed(url)
)

afterAll(destroy(Stack))

let keys = 0

/** A turn key no other test used: every test shares the one relay. */
const freshKey = () => `workers-test-${Date.now()}-${String(++keys).padStart(4, "0")}`

/** A session no other test used, so a turn left running elsewhere never makes it busy. */
const freshSession = () => `s${Date.now().toString(36)}${String(++keys)}`

const watch = { authorization: `Bearer ${WATCH_TOKEN}` }

const json = (response: HttpClientResponse.HttpClientResponse) => response.json

const submit = (url: string, session: string, key: string, text: string) =>
  HttpClient.post(new URL(`/v1/turn?session=${session}`, url).toString(), {
    headers: { ...watch, "idempotency-key": key },
    body: HttpBody.jsonUnsafe({ text })
  })

const status = (url: string, session = "main") =>
  HttpClient.get(new URL(`/v1/status?session=${session}`, url).toString(), { headers: watch }).pipe(
    Effect.flatMap(json)
  )

const StatusBody = Schema.Struct({
  agent: Schema.Struct({ name: Schema.optionalKey(Schema.String), online: Schema.Boolean })
})

/** Polls `/v1/status` until the agent's `online` is `online`. */
const waitForOnline = (url: string, online: boolean) =>
  status(url).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(StatusBody)),
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (body) => body.agent.online === online,
      times: 100
    })
  )

/** The real runner, connected to `url`, driving `agent`, until the test's scope closes. */
const startRunner = Effect.fnUntraced(function*(url: string, agent: Layer.Layer<Agent.Agent>) {
  const fiber = yield* Connection.run.pipe(
    Effect.provide(
      Executor.layer.pipe(Layer.provideMerge(agent), Layer.provideMerge(NodeSocket.layerWebSocketConstructor))
    ),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ SIDEBAND_BACKEND_URL: url, SIDEBAND_RUNNER_TOKEN: RUNNER_TOKEN })
    ),
    Effect.forkScoped
  )

  yield* waitForOnline(url, true)

  return fiber
})

/**
 * Opens a WebSocket to the relay with the runner token, sends `frames` once it opens, and waits for the relay
 * to close it. Answers the close code.
 */
const closeCode = Effect.fnUntraced(function*(url: string, frames: ReadonlyArray<string>) {
  const makeWebSocket = yield* Socket.WebSocketConstructor
  const connect = new URL(CONNECT_PATH, url)
  connect.protocol = "ws:"

  return yield* Effect.callback<number | undefined>((resume) => {
    const ws = makeWebSocket(connect.href, { headers: { authorization: `Bearer ${RUNNER_TOKEN}` } })

    ws.addEventListener("open", () => {
      for (const frame of frames) ws.send(frame)
    })

    ws.addEventListener("close", (event) => resume(Effect.succeed(event.code)))

    return Effect.sync(() => ws.close())
  })
}, Effect.provide(NodeSocket.layerWebSocketConstructor))

const hello = (protocol: number, agent: string) =>
  JSON.stringify({ type: "hello", protocol, runner_version: "test", agent: { name: agent }, in_flight: [] })

test(
  "GET /healthz pings the Relay, whose SQLite is migrated",
  Effect.gen(function*() {
    const url = yield* workerUrl
    const response = yield* Test.getWhenReady(new URL("/healthz", url).toString())

    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ ok: true, relay: "ok" })
  })
)

test(
  "every watch API operation needs the watch token: without it, each is a 401 in the protocol's error shape",
  Effect.gen(function*() {
    const url = yield* workerUrl
    const spec = OpenApi.fromApi(Api.SidebandApi)

    const operations = Object.entries(spec.paths).flatMap(([path, item]) => [
      ...item.get ? [{ method: "GET" as const, path }] : [],
      ...item.post ? [{ method: "POST" as const, path }] : []
    ])

    expect(operations.length).toBeGreaterThan(0)

    for (const { method, path } of operations) {
      const concrete = path.replaceAll(/\{[^}]+\}/g, "main-0000000000000000")
      const response = yield* HttpClient.execute(HttpClientRequest.make(method)(new URL(concrete, url)))

      expect(response.status, `${method} ${path}`).toBe(401)
      expect(yield* response.json, `${method} ${path}`).toMatchObject({ error: "unauthorized", retryable: false })
    }
  })
)

test(
  "the runner connection needs the runner token",
  Effect.gen(function*() {
    const url = yield* workerUrl

    // The token is checked before the upgrade (fetch can't send `Upgrade` anyway).
    for (const headers of [{}, watch]) {
      const response = yield* HttpClient.get(new URL(CONNECT_PATH, url).toString(), { headers })

      expect(response.status).toBe(401)
    }
  })
)

test(
  "a text turn goes from the watch API through the relay to the runner and back",
  Effect.gen(function*() {
    const url = yield* workerUrl
    yield* startRunner(url, Echo.layer({ delayMs: 0 }))
    const key = freshKey()
    const session = freshSession()
    const response = yield* submit(url, session, key, "Deploy it.")

    expect(response.status).toBe(200)
    expect(yield* response.json).toMatchObject({ status: "completed", idempotency_key: key, watch_text: "Deploy it." })

    const replay = yield* submit(url, session, key, "Deploy it.")
    expect(yield* replay.json).toMatchObject({ status: "completed", watch_text: "Deploy it." })

    const conflict = yield* submit(url, session, key, "Something else.")
    expect(conflict.status).toBe(422)
    expect(yield* conflict.json).toMatchObject({ error: "idempotency_conflict" })

    const stored = yield* HttpClient.get(new URL(`/v1/turns/${key}`, url).toString(), { headers: watch })
    expect(yield* stored.json).toMatchObject({ status: "completed", watch_text: "Deploy it." })

    expect(yield* status(url)).toMatchObject({ agent: { name: "echo", online: true } })
  }).pipe(Effect.scoped)
)

test(
  "a session op while a turn runs is session_busy; the turn still completes",
  Effect.gen(function*() {
    const url = yield* workerUrl
    const gate = yield* Latch.make()

    const slow = Layer.effect(
      Agent.Agent,
      Effect.map(Agent.Agent, (echo) =>
        Agent.Agent.of({
          ...echo,
          runTurn: Effect.fn("Slow.runTurn")(function*(turn) {
            yield* gate.await

            return yield* echo.runTurn(turn)
          })
        }))
    ).pipe(Layer.provide(Echo.layer({ delayMs: 0 })))

    yield* startRunner(url, slow)
    const session = freshSession()
    const turn = yield* submit(url, session, freshKey(), "Take your time.").pipe(Effect.forkScoped)

    const busy = yield* HttpClient.post(new URL(`/v1/sessions/${session}/new`, url).toString(), { headers: watch })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("50 millis"),
          until: (response) => response.status === 409,
          times: 100
        })
      )

    expect(yield* busy.json).toMatchObject({ error: "session_busy", retryable: true })
    yield* gate.open
    const completed = yield* Fiber.join(turn)

    expect(yield* completed.json).toMatchObject({ status: "completed", watch_text: "Take your time." })
  }).pipe(Effect.scoped)
)

test(
  "with no runner, a turn is agent_offline and the status says offline, keeping the last agent's name",
  Effect.gen(function*() {
    const url = yield* workerUrl

    yield* Effect.scoped(startRunner(url, Echo.layer({ delayMs: 0 })))
    yield* waitForOnline(url, false)

    const response = yield* submit(url, freshSession(), freshKey(), "Anyone there?")

    expect(response.status).toBe(503)
    expect(yield* response.json).toMatchObject({ error: "agent_offline", retryable: true })
    expect(yield* status(url)).toMatchObject({ agent: { name: "echo", online: false } })

    const missing = yield* HttpClient.get(new URL(`/v1/turns/${freshKey()}`, url).toString(), { headers: watch })
    expect(missing.status).toBe(404)
    expect(yield* missing.json).toMatchObject({ error: "not_found" })
  })
)

test(
  "a second runner replaces the first, whose run then ends successfully (launchd leaves it down)",
  Effect.gen(function*() {
    const url = yield* workerUrl
    const first = yield* startRunner(url, Echo.layer({ delayMs: 0 }))

    yield* closeCode(url, [hello(2, "second")]).pipe(Effect.forkScoped)

    expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
  }).pipe(Effect.scoped)
)

test(
  "a hello in a protocol the relay doesn't speak is closed with 4002",
  Effect.gen(function*() {
    const url = yield* workerUrl

    expect(yield* closeCode(url, [hello(99, "future")])).toBe(4002)
  })
)

test(
  "a hello too large to keep with the socket is closed with 1008, and the relay stays up",
  Effect.gen(function*() {
    const url = yield* workerUrl

    expect(yield* closeCode(url, [hello(2, "x".repeat(20_000))])).toBe(1008)
    expect((yield* Test.getWhenReady(new URL("/healthz", url).toString())).status).toBe(200)
  })
)
