import { describe, expect, it } from "@effect/vitest"
import { Agent, Echo } from "@sideband/agents"
import { Common, Runner } from "@sideband/protocol"
import { Clock, ConfigProvider, Context, Effect, Fiber, Latch, Layer, Option, Queue, Schema } from "effect"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import * as Connection from "../src/Connection/Connection.ts"
import { Executor } from "../src/Executor/Executor.ts"

const KEY = Common.IdempotencyKey.make("turn-0000000000000001")

type Listener = (event: Socket.WebSocketEvent) => void

/** The relay's end of one connection: the test opens, answers, and closes it. */
class RelaySide implements Socket.WebSocketLike {
  readyState = 0
  readonly url: string
  readonly options: Socket.WebSocketConstructorOptions | undefined
  /** Frames the runner sent that the test hasn't read yet, in order. */
  readonly frames: Array<string> = []
  readonly #listeners = new Map<string, Set<Listener>>()

  constructor(url: string, options: Socket.WebSocketConstructorOptions | undefined) {
    this.url = url
    this.options = options
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.#listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener) {
    this.#listeners.get(type)?.delete(listener)
  }

  close() {
    this.readyState = 3
  }

  send(data: string | Uint8Array) {
    if (this.readyState !== 1) throw new Error("not open")

    this.frames.push(data instanceof Uint8Array ? new TextDecoder().decode(data) : data)
  }

  #dispatch(type: string, event: Socket.WebSocketEvent) {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  open() {
    this.readyState = 1
    this.#dispatch("open", {})
  }

  receive(message: Runner.RelayMessage) {
    this.receiveFrame(JSON.stringify(message))
  }

  receiveFrame(frame: string) {
    this.#dispatch("message", { data: frame })
  }

  closeWith(code: number) {
    this.readyState = 3
    this.#dispatch("close", { code, reason: "" })
  }

  /** The connection never opens, as when the relay is down or refuses the upgrade. */
  refuse() {
    this.readyState = 3
    this.#dispatch("error", {})
    this.#dispatch("close", { code: 1006, reason: "" })
  }
}

const decodeRunnerMessage = Schema.decodeSync(Schema.fromJsonString(Runner.RunnerMessage))

/** The next frame the runner sends on `relay`, once it does. */
const next = Effect.fnUntraced(function*(relay: RelaySide) {
  while (true) {
    const frame = relay.frames.shift()

    if (frame !== undefined) return frame

    yield* Effect.yieldNow
  }
})

/**
 * Runs the connection against a fake relay, with an agent whose turns finish once `gate` opens. Each
 * connection the runner dials appears on `dialed`.
 */
const start = Effect.gen(function*() {
  const dialed = yield* Queue.unbounded<RelaySide>()
  const gate = yield* Latch.make()

  const constructor = Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
    const socket = new RelaySide(url, options)
    Queue.offerUnsafe(dialed, socket)

    return socket
  })

  const echo = yield* Layer.build(Echo.layer({ delayMs: 0 })).pipe(Effect.map((c) => Context.get(c, Agent.Agent)))

  const agent = Layer.succeed(Agent.Agent)({
    ...echo,
    runTurn: Effect.fnUntraced(function*(turn) {
      yield* gate.await

      return yield* echo.runTurn(turn)
    })
  })

  const context = yield* Layer.build(
    Layer.mergeAll(Executor.layer.pipe(Layer.provideMerge(agent)), constructor)
  )

  const run = yield* Connection.run.pipe(
    Effect.provide(context),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      SIDEBAND_BACKEND_URL: "https://relay.test",
      SIDEBAND_RUNNER_TOKEN: "runner-token"
    }))),
    Effect.forkChild
  )

  /** The next connection the runner dials, advancing the clock until it does. */
  const nextConnection = Effect.gen(function*() {
    while (true) {
      const socket = yield* Queue.poll(dialed)

      if (Option.isSome(socket)) return socket.value

      yield* TestClock.adjust("100 millis")
    }
  })

  /** Opens the next connection and reads its `hello`. */
  const connect = Effect.gen(function*() {
    const relay = yield* nextConnection
    relay.open()

    const hello = decodeRunnerMessage(yield* next(relay))

    return { relay, hello }
  })

  return { run, gate, nextConnection, connect, executor: Context.get(context, Executor) }
})

const nextMessage = (relay: RelaySide) => Effect.map(next(relay), decodeRunnerMessage)

const turn: Runner.Turn = {
  type: "turn",
  key: KEY,
  session: Common.SessionName.make("main"),
  transcript: "Deploy it."
}

describe("Connection", () => {
  it.effect("dials the relay's connect URL with the runner token", () =>
    Effect.gen(function*() {
      const { nextConnection } = yield* start
      const relay = yield* nextConnection

      expect(relay.url).toBe("wss://relay.test/v1/runner/connect")
      expect(relay.options).toEqual({ headers: { authorization: "Bearer runner-token" } })
    }))

  it.effect("sends hello first, then pings", () =>
    Effect.gen(function*() {
      const { connect } = yield* start
      const { relay, hello } = yield* connect

      expect(hello).toEqual({
        type: "hello",
        protocol: Runner.RUNNER_PROTOCOL_VERSION,
        runner_version: "0.0.0",
        agent: { name: "echo" },
        in_flight: []
      })
      expect(yield* next(relay)).toBe(Runner.HEARTBEAT_PING)

      yield* TestClock.adjust("15 seconds")
      expect(yield* next(relay)).toBe(Runner.HEARTBEAT_PING)
    }))

  it.effect("answers a turn on the connection it came from", () =>
    Effect.gen(function*() {
      const { connect, gate } = yield* start
      const { relay } = yield* connect
      yield* next(relay)

      relay.receive(turn)
      expect(yield* nextMessage(relay)).toEqual({ type: "ack", key: KEY })

      yield* gate.open
      expect(yield* nextMessage(relay)).toEqual({
        type: "result",
        key: KEY,
        agent_session_id: `echo-${KEY}`,
        watch_text: "Deploy it."
      })
    }))

  it.effect("ignores a relay message it can't read", () =>
    Effect.gen(function*() {
      const { connect, gate } = yield* start
      const { relay } = yield* connect
      yield* next(relay)
      yield* gate.open

      relay.receiveFrame("{\"type\":\"from_the_future\"}")
      relay.receive(turn)
      expect(yield* nextMessage(relay)).toEqual({ type: "ack", key: KEY })
    }))

  it.effect("an outcome emitted while disconnected goes out after the next hello, which lists it in flight", () =>
    Effect.gen(function*() {
      const { connect, nextConnection, gate, executor } = yield* start
      const first = yield* connect
      yield* next(first.relay)
      first.relay.receive(turn)
      yield* nextMessage(first.relay)
      first.relay.closeWith(1006)

      const second = yield* nextConnection
      yield* gate.open

      while ((yield* executor.inFlight).length > 0) yield* Effect.yieldNow

      second.open()
      expect(decodeRunnerMessage(yield* next(second))).toMatchObject({ type: "hello", in_flight: [KEY] })
      expect(yield* nextMessage(second)).toMatchObject({ type: "result", key: KEY })
    }))

  it.effect("a turn still running when the connection drops is in flight in the next hello", () =>
    Effect.gen(function*() {
      const { connect } = yield* start
      const first = yield* connect
      yield* next(first.relay)
      first.relay.receive(turn)
      yield* nextMessage(first.relay)
      first.relay.closeWith(1006)

      const { hello } = yield* connect

      expect(hello).toMatchObject({ type: "hello", in_flight: [KEY] })
    }))

  it.effect("connections that never open are retried with growing delays, reset once one opens", () =>
    Effect.gen(function*() {
      const { nextConnection, connect } = yield* start

      /** Seconds from now until the runner dials again. */
      const delayUntilRedial = Effect.gen(function*() {
        const from = yield* Clock.currentTimeMillis
        const relay = yield* nextConnection

        return { relay, seconds: ((yield* Clock.currentTimeMillis) - from) / 1000 }
      })

      const refused = yield* nextConnection
      refused.refuse()

      // 1 s, doubling, each ±20 % (and up to one 100 ms clock step late).
      for (const base of [1, 2, 4, 8, 16, 30, 30]) {
        const { relay, seconds } = yield* delayUntilRedial
        relay.refuse()

        expect(seconds).toBeGreaterThanOrEqual(base * 0.8)
        expect(seconds).toBeLessThanOrEqual(Math.min(base * 1.2, 30) + 0.1)
      }

      const { relay } = yield* connect
      relay.closeWith(1006)

      const afterOpen = yield* delayUntilRedial
      afterOpen.relay.refuse()

      const retry = yield* delayUntilRedial

      expect(afterOpen.seconds).toBeLessThanOrEqual(1.1)
      expect(retry.seconds).toBeLessThanOrEqual(1.3)
    }))
})

/**
 * launchd restarts the runner only when it exits non-zero (`KeepAlive.SuccessfulExit = false`), and
 * `BunRuntime.runMain` exits 0 when `run` succeeds and 1 when it fails.
 */
describe("Connection.run's exit, which launchd acts on", () => {
  it.effect("succeeds when another runner replaces this one (4000), so launchd leaves it down", () =>
    Effect.gen(function*() {
      const { connect, run } = yield* start
      const { relay } = yield* connect

      relay.closeWith(Connection.CLOSE_REPLACED)
      yield* Fiber.join(run)
    }))

  it.effect("falls back to protocol 1 on 4002, and fails if the relay rejects that too", () =>
    Effect.gen(function*() {
      const { connect, run } = yield* start
      const first = yield* connect
      first.relay.closeWith(Connection.CLOSE_UNSUPPORTED_PROTOCOL)

      const second = yield* connect
      expect(second.hello).toMatchObject({ type: "hello", protocol: 1 })
      second.relay.closeWith(Connection.CLOSE_UNSUPPORTED_PROTOCOL)

      const error = yield* Fiber.join(run).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Connection.UnsupportedProtocol)
    }))

  it.effect("keeps reconnecting after any other close, a refused connection, or a missing pong", () =>
    Effect.gen(function*() {
      const { connect, nextConnection, run } = yield* start

      const closed = yield* connect
      closed.relay.closeWith(1011)

      const refused = yield* nextConnection
      refused.refuse()

      const silent = yield* connect
      yield* next(silent.relay)

      // Pongs keep the connection: three pings answered, no redial.
      for (let i = 0; i < 3; i++) {
        silent.relay.receiveFrame(Runner.HEARTBEAT_PONG)
        yield* TestClock.adjust("15 seconds")
        expect(yield* next(silent.relay)).toBe(Runner.HEARTBEAT_PING)
      }

      // Then the relay stops answering: the runner gives up on it after 30 s and dials again.
      yield* nextConnection
      expect(run.pollUnsafe()).toBeUndefined()
    }))
})
