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
 * Its logical id, `"Relay"`, is permanent: it is the Durable Object class name.
 */
import type * as cf from "@cloudflare/workers-types"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import { type Common, Runner, type Status, type Turn } from "@sideband/protocol"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Clock, Deferred, Effect, Layer, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient, type SqlError } from "effect/sql"
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
    Lifecycle.AgentOffline | Lifecycle.SessionBusy | Lifecycle.IdempotencyConflict | Lifecycle.StorageFailed
  >
  readonly get: (
    key: Common.IdempotencyKey
  ) => Effect.Effect<typeof Turn.TurnState.Encoded, Lifecycle.TurnNotFound | Lifecycle.StorageFailed>
  readonly status: (
    session: Common.SessionName
  ) => Effect.Effect<typeof Status.Status.Encoded, Lifecycle.StorageFailed>
  readonly sessionOp: (
    session: Common.SessionName,
    op: Runner.SessionOp["op"]
  ) => Effect.Effect<
    typeof Status.SessionState.Encoded,
    | Lifecycle.AgentOffline
    | Lifecycle.SessionBusy
    | Lifecycle.OpNotSupported
    | Lifecycle.OpFailed
    | Lifecycle.StorageFailed
  >
  /** `"ok"` once this object's SQLite is migrated to the newest bundled migration. */
  readonly ping: () => Effect.Effect<"ok", Lifecycle.StorageFailed>
}>()("Relay", {
  errors: [
    Lifecycle.AgentOffline,
    Lifecycle.SessionBusy,
    Lifecycle.IdempotencyConflict,
    Lifecycle.TurnNotFound,
    Lifecycle.OpNotSupported,
    Lifecycle.OpFailed,
    Lifecycle.StorageFailed
  ]
}) {}

/** `WebSocket.OPEN`. */
const OPEN = 1

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(Runner.RelayMessage))

const now = Effect.map(Clock.currentTimeMillis, Lifecycle.EpochMillis.make)

/**
 * Close code for a runner frame the relay couldn't save. A standard one (internal error): the runner
 * reconnects, and its `hello` re-sends or expires what that frame was about.
 */
export const CLOSE_STORAGE_FAILED = 1011

/** Close code for a `hello` the relay can't keep with the socket (policy violation: it's too large). */
export const CLOSE_HELLO_REJECTED = 1008

/**
 * A storage failure is an error the caller sees (`StorageFailed`), not a defect. A row of ours that doesn't
 * decode is a defect: the table's checks keep every row to a state `Lifecycle` models.
 */
export const storageErrors = <A, R>(
  effect: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, R>
): Effect.Effect<A, Lifecycle.StorageFailed, R> =>
  effect.pipe(
    Effect.catchTag("SchemaError", (error) => Effect.die(error)),
    Effect.mapError((error) => new Lifecycle.StorageFailed({ message: error.message }))
  )

/**
 * Runs the event a runner frame causes. If it can't be saved, the socket closes: the runner thinks the frame
 * arrived, so only its next `hello` can recover it (a lost outcome's turn is re-sent, or expires).
 */
export const closeOnStorageFailure = <R>(
  close: (code: number, reason: string) => Effect.Effect<void>
) =>
(effect: Effect.Effect<unknown, Lifecycle.StorageFailed, R>): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchTag("StorageFailed", (error) =>
      Effect.logError("couldn't save a runner frame; closing the socket", error.message).pipe(
        Effect.andThen(close(CLOSE_STORAGE_FAILED, "storage failed"))
      ))
  )

/** Where a frame goes: the runner's socket. */
export interface Outbound {
  readonly send: (frame: string) => void
}

/**
 * Sends `frame` to the runner. A socket that closed in the meantime is not an error: the event's writes are
 * saved, so the turn is stored as sent and the runner's next `hello` re-sends it (or, for a steer, expires it).
 */
export const send = Effect.fnUntraced(function*(socket: Outbound, frame: string) {
  yield* Effect.try(() => socket.send(frame)).pipe(
    Effect.catch((error) => Effect.logWarning("the runner socket closed before a send", error.message))
  )
})

/** The open `submit` calls holding for one turn's outcome. */
interface TurnWaiters {
  readonly settled: Deferred.Deferred<void>
  count: number
}

/** An open `sessionOp` call waiting for the runner. */
interface OpWaiter {
  readonly session: Common.SessionName
  readonly answered: Deferred.Deferred<Lifecycle.SessionOpOutcome>
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
      const withSql = Effect.provideContext(sqlite)
      yield* Migrations.run.pipe(withSql, Effect.orDie)
      // Heartbeats are answered without waking the object.
      yield* state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(Runner.HEARTBEAT_PING, Runner.HEARTBEAT_PONG)
      )

      if ((yield* Effect.promise(() => state.raw.storage.getAlarm())) === null) {
        const at = Lifecycle.after(yield* now, Lifecycle.CLEANUP_INTERVAL)
        yield* Effect.promise(() => state.raw.storage.setAlarm(at))
      }

      const turnWaiters = new Map<Common.IdempotencyKey, TurnWaiters>()
      const opWaiters = new Map<Runner.OpId, OpWaiter>()

      const act = Effect.fnUntraced(function*(command: Lifecycle.Command, socket: Cloudflare.WebSocket | undefined) {
        yield* Lifecycle.Command.match(command, {
          Send: Effect.fnUntraced(function*({ message }) {
            if (!socket) return yield* Effect.die(`no runner socket to send ${message.type} on`)
            yield* send(socket.ws, yield* encodeMessage(message).pipe(Effect.orDie))

            yield* Runner.RelayMessage.match(message, {
              turn: ({ key }) => Effect.logInfo("→ runner").pipe(Effect.annotateLogs({ turn: key })),
              steer: ({ key, into }) =>
                Effect.logInfo(`→ runner, steering into ${into}`).pipe(Effect.annotateLogs({ turn: key })),
              session_op: ({ op, session }) => Effect.logInfo(`${op} → runner`).pipe(Effect.annotateLogs({ session }))
            })
          }),
          TurnSettled: ({ key }) =>
            Effect.suspend(() => {
              const waiters = turnWaiters.get(key)
              turnWaiters.delete(key)

              return waiters ? Deferred.succeed(waiters.settled, undefined) : Effect.void
            }),
          Answer: ({ opId, outcome }) =>
            Effect.suspend(() => {
              const waiter = opWaiters.get(opId)

              return waiter ? Deferred.succeed(waiter.answered, outcome) : Effect.void
            }),
          Attach: Effect.fnUntraced(function*({ hello }) {
            if (!socket) return yield* Effect.die("no runner socket to attach hello to")
            const attachment = yield* socket.getAttachment(Lifecycle.Attachment).pipe(Effect.orDie)

            // The hello comes from the runner, so it can be too large to keep with the socket. The frames after
            // it then find the socket closed, and the runner's next connection starts over.
            yield* socket.setAttachment(Lifecycle.Attachment, {
              ...attachment,
              hello: { runner_version: hello.runner_version, agent: hello.agent, protocol: hello.protocol }
            }).pipe(
              Effect.catchTag(
                "WebSocketAttachmentError",
                (error) =>
                  Effect.logWarning("runner hello rejected: can't keep it with the socket", error.message).pipe(
                    Effect.andThen(socket.close(CLOSE_HELLO_REJECTED, "hello too large"))
                  )
              )
            )
          }),
          SetAlarm: ({ at }) => Effect.promise(() => state.raw.storage.setAlarm(at))
        })
      })

      /** Read → step → save in one transaction, then act. One span per event, named by its tag. */
      const run = <A>(
        event: Lifecycle.Event,
        step: (slice: Lifecycle.Slice, now: Lifecycle.EpochMillis) => Lifecycle.Step<A>,
        socket?: Cloudflare.WebSocket
      ) =>
        Effect.gen(function*() {
          const client = yield* SqlClient.SqlClient
          const at = yield* now

          const { result, pruned } = yield* client.withTransaction(Effect.gen(function*() {
            const stepped = step(yield* Lifecycle.read(Store.source, event), at)

            return { result: stepped, pruned: yield* Store.save(stepped.writes) }
          }))

          for (const row of result.writes.turns) {
            if (row.state === "unknown") yield* Effect.logInfo("→ unknown").pipe(Effect.annotateLogs({ turn: row.key }))
          }

          if (pruned > 0) yield* Effect.logInfo(`pruned ${pruned} old turns`)

          for (const command of result.commands) yield* act(command, socket)

          return result.answer
        }).pipe(withSql, storageErrors, Effect.withSpan(`Relay.event.${event._tag}`))

      /** The connected runner that has said hello, if any, and whether its heartbeat is fresh. */
      const runnerSocket = Effect.gen(function*() {
        const at = yield* now

        for (const socket of yield* state.getWebSockets()) {
          if (socket.ws.readyState !== OPEN) continue
          const attachment = yield* socket.getAttachment(Lifecycle.Attachment).pipe(Effect.option)

          if (Option.isNone(attachment) || attachment.value.hello === undefined) continue
          const lastPing = yield* state.getWebSocketAutoResponseTimestamp(socket.ws)

          const view: Lifecycle.RunnerView = {
            online: Lifecycle.isOnline(attachment.value.connectedAt, lastPing?.getTime(), at),
            protocol: attachment.value.hello.protocol
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
          (slice, at) => Lifecycle.check(slice, view, at)
        )

        return Option.flatMap(found, ({ socket }) => runner ? Option.some({ socket, runner }) : Option.none())
      })

      const storedState = (key: Common.IdempotencyKey) =>
        Store.turn(key).pipe(Effect.map(Option.map(Lifecycle.turnState)), withSql, storageErrors)

      /** Waits until `key` resolves, or `Lifecycle.HOLD` passes. */
      const waitForOutcome = (key: Common.IdempotencyKey) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const waiters = turnWaiters.get(key) ?? { settled: Deferred.makeUnsafe<void>(), count: 0 }
            waiters.count++
            turnWaiters.set(key, waiters)

            return waiters
          }),
          (waiters) => Deferred.await(waiters.settled).pipe(Effect.timeoutOption(Lifecycle.HOLD)),
          (waiters) =>
            Effect.sync(() => {
              waiters.count--

              if (waiters.count === 0 && turnWaiters.get(key) === waiters) turnWaiters.delete(key)
            })
        )

      /** The runner's answer to session op `opId`, or `None` after `Lifecycle.SESSION_OP_TIMEOUT`. */
      const waitForAnswer = (opId: Runner.OpId, session: Common.SessionName) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const answered = Deferred.makeUnsafe<Lifecycle.SessionOpOutcome>()
            opWaiters.set(opId, { session, answered })

            return answered
          }),
          (answered) => Deferred.await(answered).pipe(Effect.timeoutOption(Lifecycle.SESSION_OP_TIMEOUT)),
          () => Effect.sync(() => opWaiters.delete(opId))
        )

      const submit = Effect.fn("Relay.submit")(
        function*(turn: Lifecycle.SubmitTurn) {
          const live = Option.getOrUndefined(yield* liveRunner)

          const answer = yield* run(
            Lifecycle.Event.cases.Submit.make({ turn, runner: live?.runner }),
            (slice, at) => Lifecycle.submit(slice, turn, live?.runner, at),
            live?.socket
          )

          const accepted = yield* Effect.fromResult(answer)

          if (Lifecycle.Accepted.guards.Replay(accepted)) return Lifecycle.turnState(accepted.row)
          yield* waitForOutcome(accepted.key)
          const stored = yield* storedState(accepted.key)

          return yield* Option.match(stored, {
            onNone: () => Effect.die(`turn ${accepted.key} vanished while held`),
            onSome: Effect.succeed
          })
        },
        (effect, turn) => Effect.annotateLogs(effect, { turn: turn.key, session: turn.session }),
        handler
      )

      const get = Effect.fn("Relay.get")(function*(key: Common.IdempotencyKey) {
        yield* liveRunner

        return yield* Effect.fromOption(
          yield* storedState(key),
          () => new Lifecycle.TurnNotFound({ message: `No turn ${key}.` })
        )
      }, handler)

      const sessionState = (name: Common.SessionName) =>
        Store.session(name).pipe(
          Effect.map((row) => Lifecycle.sessionState(name, Option.getOrUndefined(row))),
          withSql,
          storageErrors
        )

      const status = Effect.fn("Relay.status")(function*(session: Common.SessionName) {
        const live = yield* liveRunner
        const agentName = yield* Store.agentName.pipe(withSql, storageErrors)

        return Lifecycle.status(agentName, Option.isSome(live), yield* sessionState(session))
      }, handler)

      const sessionOp = Effect.fn("Relay.sessionOp")(
        function*(session: Common.SessionName, op: Runner.SessionOp["op"]) {
          const live = Option.getOrUndefined(yield* liveRunner)
          const opId = Runner.OpId.make(crypto.randomUUID())

          const answer = yield* run(
            Lifecycle.Event.cases.SessionOp.make({ session, op, opId, runner: live?.runner }),
            (slice) => Lifecycle.sessionOp(slice, { session, op, opId }, live?.runner),
            live?.socket
          )

          yield* Effect.fromResult(answer)
          yield* Effect.fromResult(Lifecycle.sessionOpResult(yield* waitForAnswer(opId, session)))

          return yield* sessionState(session)
        },
        (effect, session) => Effect.annotateLogs(effect, { session }),
        handler
      )

      const ping = Effect.fn("Relay.ping")(function*() {
        const applied = yield* Migrations.latestApplied.pipe(withSql, storageErrors)

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
              (slice, at) => Lifecycle.outcome(slice, result, at),
              socket
            )),
            Effect.annotateLogs({ turn: result.key })
          )

        // An answer after the op timed out has no one to tell, and is dropped.
        const sessionOpAnswer = (result: Lifecycle.SessionOpOutcome) =>
          Effect.suspend(() => {
            const waiter = opWaiters.get(result.op_id)

            if (!waiter) return Effect.void
            const answer = { session: waiter.session, opId: result.op_id, outcome: result }

            return run(
              Lifecycle.Event.cases.SessionOpAnswer.make(answer),
              (slice, at) => Lifecycle.sessionOpAnswer(slice, answer, at),
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
                (slice, at) => Lifecycle.hello(slice, hello, at),
                socket
              ))
            ),
          ack: ({ key }) =>
            run(Lifecycle.Event.cases.Ack.make({ key }), (slice, at) => Lifecycle.ack(slice, key, at), socket),
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
          yield* socket.setAttachment(Lifecycle.Attachment, { connectedAt: yield* now }).pipe(Effect.orDie)
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
            Message: ({ message: msg }) =>
              onMessage(socket, msg).pipe(closeOnStorageFailure((code, reason) => socket.close(code, reason)))
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
          // An alarm handler that fails is retried by Cloudflare with backoff, which is the recovery wanted.
          yield* run(Lifecycle.Event.cases.Alarm.make({}), (_, at) => Lifecycle.alarm(at)).pipe(Effect.orDie)
        }, handler)
      }
    })
  })
)
