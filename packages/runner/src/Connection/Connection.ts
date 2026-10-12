import { Agent } from "@sideband/agents"
import { Runner } from "@sideband/protocol"
import { Clock, Duration, Effect, Exit, Redacted, Schedule, Schema } from "effect"
import * as Socket from "effect/socket/Socket"
import pkg from "../../package.json" with { type: "json" }
import { RunnerConfig } from "../Config.ts"
import { type Emit, Executor } from "../Executor/Executor.ts"

const PING_INTERVAL = Duration.seconds(15)

const PONG_TIMEOUT = Duration.seconds(30)

const MIN_BACKOFF = Duration.seconds(1)

const MAX_BACKOFF = Duration.seconds(30)

/** Close codes from protocol/runner.md. */
export const CLOSE_REPLACED = 4000

export const CLOSE_UNSUPPORTED_PROTOCOL = 4002

/** `WebSocket.OPEN`. */
const OPEN = 1

/** The relay doesn't speak our protocol version. Reconnecting won't help. */
export class UnsupportedProtocol extends Schema.TaggedError<UnsupportedProtocol>()("UnsupportedProtocol", {
  message: Schema.String
}) {}

/** A connection ended: the relay's close code (`0`: no pong in time), and whether it had opened. */
class Closed extends Schema.TaggedError<Closed>()("Closed", {
  code: Schema.Int,
  reason: Schema.String,
  opened: Schema.Boolean
}) {}

/** Waits between attempts that never opened: 1 s, doubling, jittered, at most 30 s. */
const backoff = Schedule.min([Schedule.exponential(MIN_BACKOFF).pipe(Schedule.jittered), Schedule.spaced(MAX_BACKOFF)])

const encode = Effect.fnUntraced(function*(message: Runner.RunnerMessage) {
  return yield* Schema.encodeEffect(Schema.fromJsonString(Runner.RunnerMessage))(message).pipe(Effect.orDie)
})

const decode = Schema.decodeExit(Schema.fromJsonString(Runner.RelayMessage))

const closedBy = (opened: boolean) => (error: Socket.SocketError) =>
  error.reason instanceof Socket.SocketCloseError
    ? new Closed({ code: error.reason.code, reason: error.reason.closeReason ?? "", opened })
    : new Closed({ code: 1006, reason: error.message, opened })

/** An outgoing frame, and the turn it settles (for `hello.in_flight`). */
interface Pending {
  readonly frame: string
  readonly settles: string | undefined
}

/**
 * Keeps one WebSocket to the relay: `hello` first, `ping` every 15 s, turns dispatched to the
 * executor. Messages emitted while disconnected wait in an outbox and go out after the next
 * `hello`. Reconnects with backoff on any close, except when another runner replaced this one
 * (succeeds) or the relay rejects our protocol (fails). A relay that predates protocol 2 rejects
 * it; we then speak 1, without steering.
 *
 * Frames are written to the WebSocket directly rather than through the `Socket` writer: the writer
 * holds writes made while disconnected and releases them as soon as the next connection opens,
 * before `hello`.
 */
export const run = Effect.gen(function*() {
  const config = yield* RunnerConfig
  const executor = yield* Executor
  const agent = yield* Agent.Agent
  const makeWebSocket = yield* Socket.WebSocketConstructor
  const url = connectUrl(config.backendUrl)

  let protocol: Runner.Hello["protocol"] = Runner.RUNNER_PROTOCOL_VERSION
  const outbox: Array<Pending> = []
  /** The socket that has sent `hello`, while it's open. */
  let current: Socket.WebSocketLike | undefined

  const emit: Emit = Effect.fnUntraced(function*(message) {
    const frame = yield* encode(message)

    if (current?.readyState === OPEN) current.send(frame)
    else outbox.push({ frame, settles: outcomeKey(message) })
  })

  const connectOnce = Effect.fn("Connection.connectOnce")(
    function*(version: Runner.Hello["protocol"]) {
      // `Socket.makeWebSocket` passes only `protocols` to the constructor, so it can't send the auth
      // header: dial through the constructor ourselves (docs/upstream.md).
      const ws = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWebSocket(url.href, { headers: { authorization: `Bearer ${Redacted.value(config.runnerToken)}` } })
        ),
        (socket) => Effect.sync(() => socket.close())
      )

      const socket = yield* Socket.fromWebSocket(Effect.succeed(ws))
      const pull = yield* Socket.readerString(socket).pipe(Effect.mapError(closedBy(false)))
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (current === ws) current = undefined
        })
      )

      // Outcomes still in the outbox count too: the relay should wait for them, not re-send.
      const inFlight = new Set([...yield* executor.inFlight, ...outbox.flatMap((p) => p.settles ?? [])])

      const hello = yield* encode({
        type: "hello",
        protocol: version,
        runner_version: pkg.version,
        agent: { name: agent.name },
        in_flight: [...inFlight]
      })

      // One synchronous step, so nothing emitted meanwhile can overtake `hello` or be left behind.
      ws.send(hello)

      for (const pending of outbox.splice(0)) ws.send(pending.frame)
      current = ws
      yield* Effect.logInfo("connected").pipe(Effect.annotateLogs({ relay: url.host, in_flight: inFlight.size }))

      let lastPong = yield* Clock.currentTimeMillis

      const heartbeat = Effect.gen(function*() {
        if ((yield* Clock.currentTimeMillis) - lastPong > Duration.toMillis(PONG_TIMEOUT)) {
          return yield* new Closed({ code: 0, reason: "no pong", opened: true })
        }

        ws.send(Runner.HEARTBEAT_PING)
        yield* Effect.sleep(PING_INTERVAL)
      }).pipe(Effect.forever)

      const receive = Effect.fnUntraced(function*(frame: string) {
        if (frame === Runner.HEARTBEAT_PONG) {
          lastPong = yield* Clock.currentTimeMillis

          return
        }

        const message = decode(frame)

        if (Exit.isFailure(message)) return yield* Effect.logWarning("ignoring relay message", frame.slice(0, 200))

        yield* Runner.RelayMessage.match(message.value, {
          turn: (turn) => executor.run(turn, emit),
          steer: (steer) => executor.steer(steer, emit),
          session_op: (op) => executor.sessionOp(op, emit)
        })
      })

      const read = Effect.gen(function*() {
        while (true) {
          for (const frame of yield* pull.pipe(Effect.mapError(closedBy(true)))) yield* receive(frame)
        }
      })

      return yield* Effect.raceFirst(read, heartbeat)
    },
    Effect.scoped
  )

  while (true) {
    const closed = yield* connectOnce(protocol).pipe(
      Effect.tapError((ended) =>
        Effect.logWarning(ended.opened ? "disconnected" : "couldn't connect").pipe(
          Effect.annotateLogs({ code: ended.code, reason: ended.reason })
        )
      ),
      // A connection that opened starts the backoff over.
      Effect.retry({ schedule: backoff, while: (ended) => !ended.opened }),
      Effect.flip
    )

    if (closed.code === CLOSE_REPLACED) {
      return yield* Effect.logWarning("another runner connected and replaced this one; exiting")
    }

    if (closed.code === CLOSE_UNSUPPORTED_PROTOCOL && protocol > 1) {
      yield* Effect.logWarning(`the relay doesn't support protocol ${protocol}; using 1 (no steering)`)
      protocol = 1

      continue
    }

    if (closed.code === CLOSE_UNSUPPORTED_PROTOCOL) {
      return yield* new UnsupportedProtocol({ message: "the relay doesn't support this runner's protocol version" })
    }

    yield* Effect.sleep(MIN_BACKOFF)
  }
})

function connectUrl(backend: URL): URL {
  const url = new URL("/v1/runner/connect", backend)
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:"

  return url
}

function outcomeKey(message: Runner.RunnerMessage): string | undefined {
  return Runner.RunnerMessage.isAnyOf(["result", "needs_approval", "turn_failed", "merged"])(message)
    ? message.key
    : undefined
}
