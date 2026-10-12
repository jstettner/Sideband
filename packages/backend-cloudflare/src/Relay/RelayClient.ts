import { Errors, Status, Turn } from "@sideband/protocol"
import * as Cloudflare from "alchemy/Cloudflare"
import { Context, Effect, Layer, Schema } from "effect"
import type * as Lifecycle from "./Lifecycle.ts"
import type { RelayDO } from "./RelayDO.ts"

/** Single user: every principal shares this relay. */
export const OWNER = "owner"

/** The relay as the watch API sees it: decoded answers, and the protocol's errors. */
export class RelayClient extends Context.Service<RelayClient, {
  /** Claims the key, relays the turn and waits up to ~25 s for its outcome (else `running`). */
  readonly submit: (turn: Lifecycle.SubmitTurn) => Effect.Effect<
    Turn.TurnState,
    Errors.AgentOffline | Errors.SessionBusy | Errors.IdempotencyConflict | Errors.InternalError
  >
  readonly get: (key: string) => Effect.Effect<Turn.TurnState, Errors.NotFound | Errors.InternalError>
  readonly status: (session: string) => Effect.Effect<Status.Status, Errors.InternalError>
  readonly sessionOp: (session: string, op: "new" | "compact") => Effect.Effect<
    Status.SessionState,
    Errors.AgentOffline | Errors.SessionBusy | Errors.NotSupported | Errors.InternalError
  >
}>()("@sideband/backend-cloudflare/RelayClient") {}

const internal = (message: string) => new Errors.InternalError({ error: "internal_error", message, retryable: true })

/** The relay's refusals, as the protocol's errors with the same message. */
const refusals = {
  AgentOffline: (e: Lifecycle.AgentOffline) =>
    Effect.fail(new Errors.AgentOffline({ error: "agent_offline", message: e.message, retryable: true })),
  SessionBusy: (e: Lifecycle.SessionBusy) =>
    Effect.fail(new Errors.SessionBusy({ error: "session_busy", message: e.message, retryable: true })),
  IdempotencyConflict: (e: Lifecycle.IdempotencyConflict) =>
    Effect.fail(
      new Errors.IdempotencyConflict({ error: "idempotency_conflict", message: e.message, retryable: false })
    ),
  TurnNotFound: (e: Lifecycle.TurnNotFound) =>
    Effect.fail(new Errors.NotFound({ error: "not_found", message: e.message, retryable: false })),
  OpNotSupported: (e: Lifecycle.OpNotSupported) =>
    Effect.fail(new Errors.NotSupported({ error: "not_supported", message: e.message, retryable: false })),
  OpFailed: (e: Lifecycle.OpFailed) => Effect.fail(internal(e.message))
}

/**
 * An RPC call to the relay, which can also fail with `RpcCallError` (the object reset, or the call didn't
 * reach it). The stub's types leave that out; it is an internal error.
 */
const call = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | Errors.InternalError, R> => {
  const rpc: Effect.Effect<A, E | Cloudflare.RpcCallError, R> = effect

  return rpc.pipe(
    Effect.catchIf(
      (error): error is Cloudflare.RpcCallError => error instanceof Cloudflare.RpcCallError,
      (error) =>
        Effect.logWarning("relay call failed", error).pipe(Effect.andThen(Effect.fail(internal(error.message))))
    )
  )
}

/** The relay answers in wire format; a value that doesn't decode is our bug, reported as internal. */
const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S) => (value: S["Encoded"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((issue) => internal(`bad relay reply: ${issue.message}`))
  )

/** The relay named {@link OWNER} in `relays`. */
export const layer = (relays: Cloudflare.DurableObject<RelayDO>) => {
  const relay = () => relays.getByName(OWNER)

  return Layer.succeed(RelayClient)({
    submit: Effect.fn("RelayClient.submit")(function*(turn) {
      const state = yield* call(relay().submit(turn)).pipe(
        Effect.catchTags({
          AgentOffline: refusals.AgentOffline,
          SessionBusy: refusals.SessionBusy,
          IdempotencyConflict: refusals.IdempotencyConflict
        })
      )

      return yield* decode(Turn.TurnState)(state)
    }),
    get: Effect.fn("RelayClient.get")(function*(key) {
      const state = yield* call(relay().get(key)).pipe(Effect.catchTags({ TurnNotFound: refusals.TurnNotFound }))

      return yield* decode(Turn.TurnState)(state)
    }),
    status: Effect.fn("RelayClient.status")(function*(session) {
      return yield* decode(Status.Status)(yield* call(relay().status(session)))
    }),
    sessionOp: Effect.fn("RelayClient.sessionOp")(function*(session, op) {
      const state = yield* call(relay().sessionOp(session, op)).pipe(
        Effect.catchTags({
          AgentOffline: refusals.AgentOffline,
          SessionBusy: refusals.SessionBusy,
          OpNotSupported: refusals.OpNotSupported,
          OpFailed: refusals.OpFailed
        })
      )

      return yield* decode(Status.SessionState)(state)
    })
  })
}
