import { Runner } from "@sideband/protocol"
import { Data, Effect, Exit, Queue, Redacted, Schedule, Schema } from "effect"
import pkg from "../../package.json" with { type: "json" }
import { Agent } from "../agent/Agent.ts"
import { RunnerConfig } from "../config.ts"
import { type Emit, Executor } from "../turns/Executor.ts"

const PING_INTERVAL_MS = 15_000
const PONG_TIMEOUT_MS = 30_000
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

/** Close codes from protocol/runner.md. */
const CLOSE_REPLACED = 4000
const CLOSE_UNSUPPORTED_PROTOCOL = 4002

/** The relay doesn't speak our protocol version. Reconnecting won't help. */
export class UnsupportedProtocol extends Data.TaggedError("UnsupportedProtocol")<{
  readonly message: string
}> {}

type SocketEvent =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Message"; readonly data: string }
  | { readonly _tag: "Close"; readonly code: number; readonly reason: string }
  | { readonly _tag: "PongTimeout" }

const decodeMessage = Schema.decodeUnknownExit(Schema.fromJsonString(Runner.RelayMessage))

/**
 * Keeps one WebSocket to the relay: `hello` first, `ping` every 15 s, turns dispatched to the
 * executor. Messages emitted while disconnected wait in an outbox and go out after the next
 * `hello`. Reconnects with backoff (≤ 30 s) on any close, except when another runner replaced
 * this one (returns) or the relay rejects our protocol (fails).
 */
export const run = Effect.gen(function*() {
  const config = yield* RunnerConfig
  const executor = yield* Executor
  const agent = yield* Agent
  const url = connectUrl(config.backendUrl)

  const outbox: Array<Runner.RunnerMessage> = []
  /** The socket that has sent `hello`, while it's open. */
  let current: WebSocket | undefined
  const emit: Emit = (message) =>
    Effect.sync(() => {
      if (current?.readyState === WebSocket.OPEN) current.send(JSON.stringify(message))
      else outbox.push(message)
    })

  const connectOnce = Effect.gen(function*() {
    const events = yield* Queue.unbounded<SocketEvent>()
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const ws = new WebSocket(url, {
          headers: { authorization: `Bearer ${Redacted.value(config.runnerToken)}` }
        })
        ws.onopen = () => Queue.offerUnsafe(events, { _tag: "Open" })
        ws.onmessage = (event) => {
          if (typeof event.data === "string") Queue.offerUnsafe(events, { _tag: "Message", data: event.data })
        }
        // An error is always followed by a close.
        ws.onclose = (event) => Queue.offerUnsafe(events, { _tag: "Close", code: event.code, reason: event.reason })
        return ws
      }),
      (ws) =>
        Effect.sync(() => {
          if (current === ws) current = undefined
          ws.close()
        })
    )

    let opened = false
    let lastPong = Date.now()
    while (true) {
      const event = yield* Queue.take(events)
      switch (event._tag) {
        case "Open": {
          opened = true
          const pending = outbox.splice(0)
          const hello: Runner.Hello = {
            type: "hello",
            protocol: Runner.RUNNER_PROTOCOL_VERSION,
            runner_version: pkg.version,
            agent: { name: agent.name },
            // Outcomes still in the outbox count too: the relay should wait for them, not re-send.
            in_flight: [...new Set([...yield* executor.inFlight, ...pending.flatMap(outcomeKey)])]
          }
          ws.send(JSON.stringify(hello))
          for (const message of pending) ws.send(JSON.stringify(message))
          current = ws
          yield* Effect.logInfo(`connected to ${url.host} (${hello.in_flight.length} in flight)`)
          yield* Effect.sync(() => {
            if (Date.now() - lastPong > PONG_TIMEOUT_MS) Queue.offerUnsafe(events, { _tag: "PongTimeout" })
            else ws.send(Runner.HEARTBEAT_PING)
          }).pipe(Effect.repeat(Schedule.spaced(PING_INTERVAL_MS)), Effect.forkScoped)
          break
        }
        case "Message": {
          if (event.data === Runner.HEARTBEAT_PONG) {
            lastPong = Date.now()
            break
          }
          const decoded = decodeMessage(event.data)
          if (Exit.isFailure(decoded)) {
            yield* Effect.logWarning(`ignoring relay message: ${event.data.slice(0, 200)}`)
            break
          }
          const message = decoded.value
          if (message.type === "turn") yield* executor.run(message, emit)
          else yield* executor.sessionOp(message, emit)
          break
        }
        case "Close":
          return { code: event.code, reason: event.reason, opened }
        case "PongTimeout":
          return { code: 0, reason: "no pong", opened }
      }
    }
  }).pipe(Effect.scoped)

  let backoff = MIN_BACKOFF_MS
  while (true) {
    const closed = yield* connectOnce
    if (closed.code === CLOSE_REPLACED) {
      yield* Effect.logWarning("another runner connected and replaced this one; exiting")
      return
    }
    if (closed.code === CLOSE_UNSUPPORTED_PROTOCOL) {
      return yield* new UnsupportedProtocol({ message: "the relay doesn't support this runner's protocol version" })
    }
    if (closed.opened) backoff = MIN_BACKOFF_MS
    const delay = Math.round(backoff * (0.5 + Math.random() / 2))
    yield* Effect.logWarning(
      `${closed.opened ? "disconnected" : "couldn't connect"} (${closed.code} ${closed.reason}); retrying in ${delay} ms`
    )
    yield* Effect.sleep(delay)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
})

function connectUrl(backend: URL): URL {
  const url = new URL("/v1/runner/connect", backend)
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:"
  return url
}

function outcomeKey(message: Runner.RunnerMessage): Array<string> {
  return message.type === "result" || message.type === "needs_approval" || message.type === "turn_failed"
    ? [message.key]
    : []
}
