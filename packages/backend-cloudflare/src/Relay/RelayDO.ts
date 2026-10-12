/**
 * `Relay`: the rendezvous between clients and the runner, one object per user (currently one, `"owner"`).
 * The Worker calls its RPC methods; the runner holds a hibernatable WebSocket to it. Only open requests
 * are kept in memory; everything else is in the object's SQLite (`Store.ts`, `Migrations.ts`).
 *
 * Every event goes through `run`: read the rows it touches, step (`Lifecycle.ts`, pure), save, act. Read,
 * step, and save run in one SQLite transaction, which holds every other event on this object, so no two
 * steps interleave. Save comes before act: if the object dies in between, the socket dies with it, and
 * the runner's next `hello` re-sends what it must.
 *
 * Its logical id, `"Relay"`, is permanent: it is the Durable Object class name, the one the objects
 * created before Alchemy have too.
 */
import type * as cf from "@cloudflare/workers-types"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import { Runner, type Status, type Turn } from "@sideband/protocol"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Clock, Deferred, Duration, Effect, Layer, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { JsonLogs } from "../Layers.ts"
import * as Lifecycle from "./Lifecycle.ts"
import * as Migrations from "./Migrations.ts"
import * as Store from "./Store.ts"

// workerd's global; Worker code is typed without the Workers globals.
declare const WebSocketRequestResponsePair: typeof cf.WebSocketRequestResponsePair

export class RelayDO extends Cloudflare.DurableObject<RelayDO, {
  /** Claims the key, relays the turn, and waits up to `Lifecycle.HOLD` for its outcome (else `running`). */
  readonly submit: (
    turn: Lifecycle.SubmitTurn
  ) => Effect.Effect<
    typeof Turn.TurnState.Encoded,
    Lifecycle.AgentOffline | Lifecycle.SessionBusy | Lifecycle.IdempotencyConflict
  >
  readonly get: (key: string) => Effect.Effect<typeof Turn.TurnState.Encoded, Lifecycle.TurnNotFound>
  readonly status: (session: string) => Effect.Effect<typeof Status.Status.Encoded>
  readonly sessionOp: (
    session: string,
    op: Runner.SessionOp["op"]
  ) => Effect.Effect<
    typeof Status.SessionState.Encoded,
    Lifecycle.AgentOffline | Lifecycle.SessionBusy | Lifecycle.OpNotSupported | Lifecycle.OpFailed
  >
  /** `"ok"` once this object's SQLite is migrated to the newest bundled migration. */
  readonly ping: () => Effect.Effect<"ok">
}>()("Relay", {
  errors: [
    Lifecycle.AgentOffline,
    Lifecycle.SessionBusy,
    Lifecycle.IdempotencyConflict,
    Lifecycle.TurnNotFound,
    Lifecycle.OpNotSupported,
    Lifecycle.OpFailed
  ]
}) {}

const OFFLINE = "The agent is offline. Nothing was run."

/** `WebSocket.OPEN`. */
const OPEN = 1

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(Runner.RelayMessage))

type SubmitResult = Effect.Effect<
  typeof Turn.TurnState.Encoded,
  Lifecycle.AgentOffline | Lifecycle.SessionBusy | Lifecycle.IdempotencyConflict,
  Alchemy.RuntimeContext
>

type SessionOpResult = Effect.Effect<
  typeof Status.SessionState.Encoded,
  Lifecycle.AgentOffline | Lifecycle.SessionBusy | Lifecycle.OpNotSupported | Lifecycle.OpFailed,
  Alchemy.RuntimeContext
>

/** The open `submit` calls waiting on one turn's outcome. */
interface TurnWaiters {
  readonly woken: Deferred.Deferred<void>
  count: number
}

export const RelayDOLive: Layer.Layer<RelayDO, never, Cloudflare.Worker> = RelayDO.make(
  // Init: runs at plan time (to discover bindings) and on each activation, before `RuntimeContext` exists.
  Effect.gen(function*() {
    const state = yield* Cloudflare.DurableObjectState

    // Instance: runs on each activation (including a wake from hibernation), with `RuntimeContext`, inside
    // the activation's `blockConcurrencyWhile`. Returns the methods; Alchemy runs it, so it is returned unrun.
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.gen(function*() {
      const runtime = yield* Alchemy.RuntimeContext

      /**
       * Around every method and socket handler: the activation's `RuntimeContext` (the shape's methods
       * declare no requirements), and JSON logs (alchemy#1954).
       */
      const handler = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(Alchemy.RuntimeContext, runtime), Effect.provide(JsonLogs))

      const sqlite = yield* Layer.build(SqliteClient.layer({ storage: state.raw.storage }))
      const sql = SqlClient.SqlClient.pipe(Effect.provideContext(sqlite))
      yield* Migrations.run.pipe(Effect.provideContext(sqlite), Effect.orDie)
      // Heartbeats are answered without waking the object.
      yield* state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(Runner.HEARTBEAT_PING, Runner.HEARTBEAT_PONG)
      )

      if ((yield* Effect.promise(() => state.raw.storage.getAlarm())) === null) {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.promise(() => state.raw.storage.setAlarm(now + Duration.toMillis(Lifecycle.CLEANUP_INTERVAL)))
      }

      const turnWaiters = new Map<string, TurnWaiters>()

      /** Open `sessionOp` calls waiting for the runner, by op id. */
      const opWaiters = new Map<
        string,
        { readonly session: string; readonly answered: Deferred.Deferred<Lifecycle.SessionOpReply> }
      >()

      const act = Effect.fnUntraced(function*(command: Lifecycle.Command, socket: Cloudflare.WebSocket | undefined) {
        yield* Lifecycle.Command.match(command, {
          Send: Effect.fnUntraced(function*({ message }) {
            if (!socket) return yield* Effect.die(`no runner socket to send ${message.type} on`)
            yield* socket.send(yield* encodeMessage(message).pipe(Effect.orDie))

            yield* Runner.RelayMessage.match(message, {
              turn: ({ key }) => Effect.logInfo("→ runner").pipe(Effect.annotateLogs({ turn: key })),
              steer: ({ key, into }) =>
                Effect.logInfo(`→ runner, steering into ${into}`).pipe(Effect.annotateLogs({ turn: key })),
              session_op: ({ op, session }) => Effect.logInfo(`${op} → runner`).pipe(Effect.annotateLogs({ session }))
            })
          }),
          Wake: ({ key }) =>
            Effect.suspend(() => {
              const waiters = turnWaiters.get(key)
              turnWaiters.delete(key)

              return waiters ? Deferred.succeed(waiters.woken, undefined) : Effect.void
            }),
          Answer: ({ opId, reply }) =>
            Effect.suspend(() => {
              const waiter = opWaiters.get(opId)

              return waiter ? Deferred.succeed(waiter.answered, reply) : Effect.void
            }),
          Attach: Effect.fnUntraced(function*({ hello }) {
            if (!socket) return yield* Effect.die("no runner socket to attach hello to")
            const attachment = yield* socket.getAttachment(Lifecycle.Attachment).pipe(Effect.orDie)

            yield* socket.setAttachment(Lifecycle.Attachment, {
              ...attachment,
              hello: { runner_version: hello.runner_version, agent: hello.agent, protocol: hello.protocol }
            }).pipe(Effect.orDie)
          }),
          SetAlarm: ({ at }) => Effect.promise(() => state.raw.storage.setAlarm(at))
        })
      })

      /** Read → step → save in one transaction, then act. */
      const run = Effect.fnUntraced(function*<A>(
        event: Lifecycle.Event,
        step: (slice: Lifecycle.Slice, now: number) => Lifecycle.Step<A>,
        socket?: Cloudflare.WebSocket
      ) {
        const client = yield* sql
        const now = yield* Clock.currentTimeMillis

        const { result, pruned } = yield* client.withTransaction(Effect.gen(function*() {
          const stepped = step(yield* Lifecycle.read(Store.source, event), now)

          return { result: stepped, pruned: yield* Store.save(stepped.writes) }
        })).pipe(Effect.provideContext(sqlite), Effect.orDie)

        for (const row of result.writes.turns) {
          if (row.state === "unknown") yield* Effect.logInfo("→ unknown").pipe(Effect.annotateLogs({ turn: row.key }))
        }

        if (pruned > 0) yield* Effect.logInfo(`pruned ${pruned} old turns`)

        for (const command of result.commands) yield* act(command, socket)

        return result.answer
      })

      /** The connected runner that has said hello, if any, and whether its heartbeat is fresh. */
      const runnerSocket = Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis

        for (const socket of yield* state.getWebSockets()) {
          if (socket.ws.readyState !== OPEN) continue
          const attachment = yield* socket.getAttachment(Lifecycle.Attachment).pipe(Effect.option)

          if (Option.isNone(attachment) || attachment.value.hello === undefined) continue
          const lastPing = yield* state.getWebSocketAutoResponseTimestamp(socket.ws)

          const view: Lifecycle.RunnerView = {
            online: Lifecycle.isOnline(attachment.value.connectedAt, lastPing?.getTime(), now),
            protocol: attachment.value.hello.protocol ?? 1
          }

          return Option.some({ socket, view })
        }

        return Option.none()
      })

      /** The runner, if it's online, after the check step (which expires old turns while it isn't). */
      const liveRunner = Effect.gen(function*() {
        const found = yield* runnerSocket
        const view = Option.getOrUndefined(Option.map(found, (runner) => runner.view))

        const runner = yield* run(
          Lifecycle.Event.cases.Check.make({ runner: view }),
          (slice, now) => Lifecycle.check(slice, view, now)
        )

        return Option.flatMap(found, ({ socket }) => runner ? Option.some({ socket, runner }) : Option.none())
      })

      const storedState = Effect.fnUntraced(function*(key: string) {
        const row = yield* Store.turn(key).pipe(Effect.provideContext(sqlite), Effect.orDie)

        return Option.match(row, { onNone: () => undefined, onSome: Lifecycle.turnState })
      })

      /** Waits until `key` resolves, or `Lifecycle.HOLD` passes. */
      const waitForOutcome = (key: string) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const waiters = turnWaiters.get(key) ?? { woken: Deferred.makeUnsafe<void>(), count: 0 }
            waiters.count++
            turnWaiters.set(key, waiters)

            return waiters
          }),
          (waiters) => Deferred.await(waiters.woken).pipe(Effect.timeoutOption(Lifecycle.HOLD)),
          (waiters) =>
            Effect.sync(() => {
              waiters.count--

              if (waiters.count === 0 && turnWaiters.get(key) === waiters) turnWaiters.delete(key)
            })
        )

      /** The runner's answer to session op `opId`, or `NoAnswer` after `Lifecycle.SESSION_OP_TIMEOUT`. */
      const waitForAnswer = (opId: string, session: string) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const answered = Deferred.makeUnsafe<Lifecycle.SessionOpReply>()
            opWaiters.set(opId, { session, answered })

            return answered
          }),
          (answered) =>
            Deferred.await(answered).pipe(
              Effect.timeoutOption(Lifecycle.SESSION_OP_TIMEOUT),
              Effect.map(Option.getOrElse(() => Lifecycle.sessionOpReply(undefined)))
            ),
          () => Effect.sync(() => opWaiters.delete(opId))
        )

      const submit = Effect.fn("Relay.submit")(
        function*(turn: Lifecycle.SubmitTurn) {
          const live = Option.getOrUndefined(yield* liveRunner)

          const answer = yield* run(
            Lifecycle.Event.cases.Submit.make({ turn, runner: live?.runner }),
            (slice, now) => Lifecycle.submit(slice, turn, live?.runner, now),
            live?.socket
          )

          return yield* Lifecycle.SubmitAnswer.match(answer, {
            Replay: ({ row }): SubmitResult => Effect.succeed(Lifecycle.turnState(row)),
            Conflict: (): SubmitResult =>
              Effect.fail(
                new Lifecycle.IdempotencyConflict({
                  message: "This Idempotency-Key was already used for a different command."
                })
              ),
            Offline: (): SubmitResult => Effect.fail(new Lifecycle.AgentOffline({ message: OFFLINE })),
            Busy: (): SubmitResult =>
              Effect.fail(
                new Lifecycle.SessionBusy({
                  message: "The agent is still working on the previous command. Nothing was run."
                })
              ),
            Hold: ({ key }): SubmitResult =>
              waitForOutcome(key).pipe(
                Effect.andThen(storedState(key)),
                Effect.filterOrElse((stored) => stored !== undefined, () => Effect.die(`turn ${key} vanished`))
              )
          })
        },
        (effect, turn) => Effect.annotateLogs(effect, { turn: turn.key, session: turn.session }),
        handler
      )

      const get = Effect.fn("Relay.get")(function*(key: string) {
        yield* liveRunner
        const stored = yield* storedState(key)

        if (stored === undefined) return yield* new Lifecycle.TurnNotFound({ message: `No turn ${key}.` })

        return stored
      }, handler)

      const sessionState = (name: string) =>
        Store.session(name).pipe(
          Effect.map((row) => Lifecycle.sessionState(name, Option.getOrUndefined(row))),
          Effect.provideContext(sqlite),
          Effect.orDie
        )

      const status = Effect.fn("Relay.status")(function*(session: string) {
        const live = yield* liveRunner
        const agentName = yield* Store.agentName.pipe(Effect.provideContext(sqlite), Effect.orDie)

        return Lifecycle.status(agentName, Option.isSome(live), yield* sessionState(session))
      }, handler)

      const sessionOp = Effect.fn("Relay.sessionOp")(
        function*(session: string, op: Runner.SessionOp["op"]) {
          const live = Option.getOrUndefined(yield* liveRunner)
          const opId = crypto.randomUUID()

          const answer = yield* run(
            Lifecycle.Event.cases.SessionOp.make({ session, op, opId, runner: live?.runner }),
            (slice) => Lifecycle.sessionOp(slice, { session, op, opId }, live?.runner),
            live?.socket
          )

          return yield* Lifecycle.SessionOpAnswer.match(answer, {
            Offline: (): SessionOpResult => Effect.fail(new Lifecycle.AgentOffline({ message: OFFLINE })),
            Busy: (): SessionOpResult =>
              Effect.fail(
                new Lifecycle.SessionBusy({ message: "The agent is still working on a command in this session." })
              ),
            Wait: (): SessionOpResult =>
              waitForAnswer(opId, session).pipe(
                Effect.flatMap(Lifecycle.SessionOpReply.match({
                  Ok: (): SessionOpResult => sessionState(session),
                  NotSupported: ({ message }): SessionOpResult =>
                    Effect.fail(new Lifecycle.OpNotSupported({ message })),
                  Failed: ({ message }): SessionOpResult => Effect.fail(new Lifecycle.OpFailed({ message })),
                  NoAnswer: (): SessionOpResult =>
                    Effect.fail(new Lifecycle.OpFailed({ message: "The runner didn't answer." }))
                }))
              )
          })
        },
        (effect, session) => Effect.annotateLogs(effect, { session }),
        handler
      )

      const ping = Effect.fn("Relay.ping")(function*() {
        const applied = yield* Migrations.latestApplied.pipe(Effect.provideContext(sqlite), Effect.orDie)

        if (applied !== Migrations.latest) {
          return yield* Effect.die(`SQLite schema not applied: at ${applied}, expected ${Migrations.latest}`)
        }

        return "ok" as const
      }, handler)

      const onMessage = Effect.fnUntraced(function*(socket: Cloudflare.WebSocket, message: Runner.RunnerMessage) {
        const outcome = (result: Lifecycle.Outcome) =>
          Effect.logInfo(`← ${result.type}`).pipe(
            Effect.andThen(run(
              Lifecycle.Event.cases.Outcome.make({ outcome: result }),
              (slice, now) => Lifecycle.outcome(slice, result, now),
              socket
            )),
            Effect.annotateLogs({ turn: result.key })
          )

        // An answer after the op timed out has no one to tell, and is dropped.
        const sessionOpAnswer = (result: Runner.SessionOpResult | Runner.SessionOpFailed) =>
          Effect.suspend(() => {
            const waiter = opWaiters.get(result.op_id)

            if (!waiter) return Effect.void
            const answer = { session: waiter.session, opId: result.op_id, outcome: result }

            return run(
              Lifecycle.Event.cases.SessionOpAnswer.make(answer),
              (slice, now) => Lifecycle.sessionOpAnswer(slice, answer, now),
              socket
            )
          })

        yield* Runner.RunnerMessage.match(message, {
          hello: (hello) =>
            Effect.logInfo("runner hello").pipe(
              Effect.annotateLogs({
                agent: hello.agent.name,
                runner_version: hello.runner_version,
                protocol: hello.protocol,
                in_flight: hello.in_flight.length
              }),
              Effect.andThen(run(
                Lifecycle.Event.cases.Hello.make({ hello }),
                (slice, now) => Lifecycle.hello(slice, hello, now),
                socket
              ))
            ),
          ack: ({ key }) =>
            run(Lifecycle.Event.cases.Ack.make({ key }), (slice, now) => Lifecycle.ack(slice, key, now), socket),
          result: outcome,
          needs_approval: outcome,
          turn_failed: outcome,
          merged: outcome,
          session_op_result: sessionOpAnswer,
          session_op_failed: sessionOpAnswer
        })
      })

      return {
        submit,
        get,
        status,
        sessionOp,
        ping,
        /** The runner's upgrade, already authenticated by the Worker. A new runner replaces the old one. */
        fetch: Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest

          if (request.headers["upgrade"]?.toLowerCase() !== "websocket") {
            return HttpServerResponse.text("expected a WebSocket upgrade", { status: 400 })
          }

          for (const old of yield* state.getWebSockets()) yield* old.close(Lifecycle.CLOSE_REPLACED, "replaced")
          const [response, socket] = yield* Cloudflare.upgrade()
          const connectedAt = yield* Clock.currentTimeMillis
          yield* socket.setAttachment(Lifecycle.Attachment, { connectedAt }).pipe(Effect.orDie)
          yield* Effect.logInfo("runner connected")

          return response
        }).pipe(Effect.withSpan("Relay.connect"), handler),
        webSocketMessage: Effect.fn("Relay.webSocketMessage")(function*(
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer
        ) {
          // Runners send text frames only.
          if (message instanceof ArrayBuffer) return

          yield* Lifecycle.Frame.match(Lifecycle.classifyFrame(message), {
            Ping: () => socket.send(Runner.HEARTBEAT_PONG),
            RejectHello: () =>
              Effect.logWarning("runner hello rejected: unsupported protocol").pipe(
                Effect.andThen(socket.close(Lifecycle.CLOSE_UNSUPPORTED_PROTOCOL, "unsupported_protocol"))
              ),
            Ignore: () => Effect.logWarning("ignoring runner message", message.slice(0, 200)),
            Message: ({ message: msg }) => onMessage(socket, msg)
          })
        }, handler),
        webSocketClose: Effect.fn("Relay.webSocketClose")(function*(
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string
        ) {
          yield* Effect.logInfo("runner disconnected").pipe(Effect.annotateLogs({ code, reason }))
          // Completes the closing handshake; the socket may already be closed.
          yield* Effect.try(() => socket.ws.close()).pipe(Effect.ignore)
        }, handler),
        webSocketError: Effect.fn("Relay.webSocketError")(function*(
          _socket: Cloudflare.WebSocket,
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- workerd reports a socket error as an unknown value; it is only logged.
          error: unknown
        ) {
          yield* Effect.logWarning("runner socket error", error)
        }, handler),
        /** Daily cleanup of old turns. */
        alarm: Effect.fn("Relay.alarm")(function*() {
          yield* run(Lifecycle.Event.cases.Alarm.make({}), (_, now) => Lifecycle.alarm(now))
        }, handler)
      }
    })
  })
)
