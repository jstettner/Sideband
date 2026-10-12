import {
  AgentOffline,
  IdempotencyConflict,
  InternalError,
  NotFound,
  NotSupported,
  SessionBusy,
  SessionState,
  Status,
  TurnState
} from "@sideband/protocol"
import { Context, Effect, Layer, Schema } from "effect"
import type { Relay, Reply, SubmitTurn } from "./Relay.ts"

/** Protocol errors the relay can refuse a request with, by code. */
const refusals = {
  agent_offline: (message: string) => new AgentOffline({ error: "agent_offline", message, retryable: true }),
  session_busy: (message: string) => new SessionBusy({ error: "session_busy", message, retryable: true }),
  idempotency_conflict: (message: string) =>
    new IdempotencyConflict({ error: "idempotency_conflict", message, retryable: false }),
  not_found: (message: string) => new NotFound({ error: "not_found", message, retryable: false }),
  not_supported: (message: string) => new NotSupported({ error: "not_supported", message, retryable: false }),
  internal_error: (message: string) => new InternalError({ error: "internal_error", message, retryable: true })
}
type Refusals = typeof refusals

/** The relay Durable Object, as seen from the Worker. */
export class RelayClient extends Context.Service<RelayClient, {
  /** Claims the key, relays the turn and waits up to ~25 s for its outcome (else `running`). */
  readonly submit: (turn: SubmitTurn) => Effect.Effect<
    TurnState,
    AgentOffline | SessionBusy | IdempotencyConflict | InternalError
  >
  readonly get: (key: string) => Effect.Effect<TurnState, NotFound | InternalError>
  readonly status: (session: string) => Effect.Effect<Status, InternalError>
  readonly sessionOp: (session: string, op: "new" | "compact") => Effect.Effect<
    SessionState,
    AgentOffline | SessionBusy | NotSupported | InternalError
  >
}>()("sideband/backend-cloudflare/relay/RelayClient") {
  /** Single-user MVP: every principal shares the `owner` relay. */
  static readonly layer = (namespace: DurableObjectNamespace<Relay>) => {
    /** Calls the relay over RPC; a failed call (e.g. the object was reset) is an internal error. */
    const call = <A>(f: (relay: DurableObjectStub<Relay>) => Promise<A>) =>
      Effect.tryPromise({
        try: () => f(namespace.getByName("owner")),
        catch: (cause) => refusals.internal_error(`relay call failed: ${String(cause)}`)
      }).pipe(Effect.tapError((e) => Effect.logWarning(e.message)))

    return Layer.succeed(RelayClient)({
      submit: (turn) => call((relay) => relay.submit(turn)).pipe(Effect.flatMap(accept(TurnState))),
      get: (key) => call((relay) => relay.get(key)).pipe(Effect.flatMap(accept(TurnState))),
      status: (session) => call((relay) => relay.status(session)).pipe(Effect.flatMap(decode(Status))),
      sessionOp: (session, op) =>
        call((relay) => relay.sessionOp(session, op)).pipe(Effect.flatMap(accept(SessionState)))
    })
  }
}

/** The relay answers in wire format; a value that doesn't decode is our bug, reported as internal. */
const decode = <S extends Schema.Codec<any, any>>(schema: S) => (value: S["Encoded"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((issue) => refusals.internal_error(`bad relay reply: ${issue.message}`))
  ) as Effect.Effect<S["Type"], InternalError>

/** Decodes the value of a successful reply, or fails with the protocol error it was refused with. */
const accept = <S extends Schema.Codec<any, any>>(schema: S) =>
<E extends keyof Refusals>(
  reply: Reply<S["Encoded"], E>
): Effect.Effect<S["Type"], ReturnType<Refusals[E]> | InternalError> =>
  reply.refused
    ? Effect.fail(refusals[reply.refused.error](reply.refused.message) as ReturnType<Refusals[E]>)
    : decode(schema)(reply.value)
