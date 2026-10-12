import type { Runner } from "@sideband/protocol"
import { Context, Deferred, Effect, FiberSet, Layer, Match, type Types } from "effect"
import { Agent } from "../agent/Agent.ts"

/** Sends a message to the relay (or holds it until the next connection). */
export type Emit = (message: Runner.RunnerMessage) => Effect.Effect<void>

/** A steer sent into a running turn, and whether the agent took it. */
interface Steer {
  readonly key: string
  readonly delivered: Deferred.Deferred<"Steered" | "NotRunning" | "Failed">
}

/** What a turn's run produced: the outcome to send, and what its steers need. */
interface Ran {
  readonly message: Runner.RunnerMessage
  readonly agentSessionId?: string | undefined
  readonly pendingSteer?: string | undefined
}

/**
 * Runs turns and session operations against the agent. Work runs in the executor's own scope,
 * so it outlives a dropped connection; outcomes go to `emit`, which buffers them until the
 * runner is connected again.
 */
export class Executor extends Context.Service<Executor, {
  /** Keys this process is still executing, for `hello.in_flight`. */
  readonly inFlight: Effect.Effect<ReadonlyArray<string>>
  /** Starts a turn: `ack` now, then exactly one outcome. Returns without waiting for it. */
  readonly run: (turn: Runner.Turn, emit: Emit) => Effect.Effect<void>
  /**
   * Starts a steer: `ack` now, then exactly one outcome. `merged` once `into` has its outcome if
   * the agent took it; otherwise the steer runs as a turn of its own (see protocol/runner.md).
   */
  readonly steer: (steer: Runner.Steer, emit: Emit) => Effect.Effect<void>
  /** Starts a session operation; answers `session_op_result` or `session_op_failed`. */
  readonly sessionOp: (op: Runner.SessionOp, emit: Emit) => Effect.Effect<void>
}>()("@sideband/runner/Executor") {
  static readonly layer = Layer.effect(
    Executor,
    Effect.gen(function*() {
      const agent = yield* Agent
      const fibers = yield* FiberSet.make()
      const inFlight = new Set<string>()
      /** Steers into each turn whose run is in progress here, in arrival order, by turn key. */
      const steerable = new Map<string, Array<Steer>>()

      const execute = (
        turn: { readonly key: string; readonly agentSessionId?: string | undefined; readonly transcript: string }
      ) =>
        agent.runTurn(turn).pipe(
          Effect.map(Match.valueTags({
            Completed: (outcome): Ran => {
              const message: Types.Mutable<Runner.TurnResult> = {
                type: "result",
                key: turn.key,
                agent_session_id: outcome.agentSessionId,
                watch_text: outcome.watchText
              }

              if (outcome.fullText !== undefined) message.full_text = outcome.fullText

              if (outcome.context !== undefined) message.context = outcome.context

              return { message, agentSessionId: outcome.agentSessionId, pendingSteer: outcome.pendingSteer }
            },
            NeedsApproval: (outcome): Ran => ({
              message: {
                type: "needs_approval",
                key: turn.key,
                agent_session_id: outcome.agentSessionId,
                message: outcome.message
              },
              agentSessionId: outcome.agentSessionId
            }),
            Failed: (outcome): Ran => ({
              message: { type: "turn_failed", key: turn.key, code: outcome.code, message: outcome.message }
            })
          })),
          Effect.catchTag("AgentUnavailable", (e): Effect.Effect<Ran> =>
            Effect.logWarning(`turn ${turn.key}: ${e.message}`).pipe(
              Effect.as({ message: { type: "turn_failed", key: turn.key, code: "agent_failed", message: e.message } })
            )),
          // Interruption (shutdown) is not an outcome: the relay re-sends the turn to the next process.
          Effect.catchDefect((defect) =>
            Effect.logError(`turn ${turn.key} crashed`, defect).pipe(
              Effect.as<Ran>({
                message: {
                  type: "turn_failed",
                  key: turn.key,
                  code: "agent_failed",
                  message: "The agent couldn't run this command."
                }
              })
            )
          )
        )

      /** Sends `key`'s outcome; it's no longer in flight. */
      const settle = (key: string, message: Runner.RunnerMessage, emit: Emit) =>
        Effect.logInfo(`turn ${key} → ${message.type}`).pipe(
          Effect.andThen(emit(message)),
          Effect.ensuring(Effect.sync(() => inFlight.delete(key)))
        )

      /**
       * Runs a turn (already acked and in flight) and sends its outcome, then resolves the steers
       * the agent took meanwhile. Steer text the agent dropped (`pendingSteer`) runs as a turn of
       * its own under the latest steer's key; the other steers are `merged`.
       */
      const runTurn = (
        turn: { readonly key: string; readonly agentSessionId?: string | undefined; readonly transcript: string },
        emit: Emit
      ): Effect.Effect<void> =>
        Effect.gen(function*() {
          steerable.set(turn.key, [])
          const ran = yield* execute(turn).pipe(Effect.onInterrupt(() => Effect.sync(() => steerable.delete(turn.key))))
          const steers = steerable.get(turn.key) ?? []
          steerable.delete(turn.key)
          yield* settle(turn.key, ran.message, emit)

          const taken: Array<Steer> = []

          for (const steer of steers) {
            if ((yield* Deferred.await(steer.delivered)) === "Steered") taken.push(steer)
          }

          const followUp = ran.pendingSteer !== undefined ? taken.pop() : undefined

          for (const steer of taken) yield* settle(steer.key, { type: "merged", key: steer.key, into: turn.key }, emit)

          if (ran.pendingSteer === undefined) return

          if (!followUp) {
            return yield* Effect.logWarning(
              `turn ${turn.key}: dropped steer text no steer here owns: ${ran.pendingSteer}`
            )
          }

          yield* Effect.logInfo(`turn ${turn.key}: steer arrived too late, running it as ${followUp.key}`)
          yield* runTurn({ key: followUp.key, agentSessionId: ran.agentSessionId, transcript: ran.pendingSteer }, emit)
        })

      /** Delivers a steer (already acked and in flight) into its running turn. */
      const deliverSteer = (msg: Runner.Steer, steer: Steer, emit: Emit) =>
        agent.steerTurn({ key: msg.into, transcript: msg.transcript }).pipe(
          Effect.tap((result) => Deferred.succeed(steer.delivered, result)),
          Effect.flatMap((result) =>
            result === "Steered"
              ? Effect.logInfo(`turn ${msg.key}: steered into ${msg.into}`)
              : Effect.logInfo(`turn ${msg.key}: ${msg.into} isn't running, running it on its own`).pipe(
                Effect.andThen(
                  runTurn({ key: msg.key, agentSessionId: msg.agent_session_id, transcript: msg.transcript }, emit)
                )
              )
          ),
          Effect.catchTag(
            "AgentUnavailable",
            (e) =>
              Effect.logWarning(`turn ${msg.key}: steer failed: ${e.message}`).pipe(
                Effect.andThen(
                  settle(msg.key, { type: "turn_failed", key: msg.key, code: "agent_failed", message: e.message }, emit)
                )
              )
          ),
          Effect.catchDefect((defect) =>
            Effect.logError(`turn ${msg.key}: steer crashed`, defect).pipe(
              Effect.andThen(settle(msg.key, {
                type: "turn_failed",
                key: msg.key,
                code: "agent_failed",
                message: "The agent couldn't take this command."
              }, emit))
            )
          ),
          // Whatever happened, `into`'s run mustn't wait on this steer forever.
          Effect.ensuring(Deferred.succeed(steer.delivered, "Failed"))
        )

      return Executor.of({
        inFlight: Effect.sync(() => [...inFlight]),
        run: Effect.fn("Executor.run")(function*(turn, emit) {
          // A turn the relay re-sent while we're still running it: the running one will answer.
          if (inFlight.has(turn.key)) return yield* emit({ type: "ack", key: turn.key })
          inFlight.add(turn.key)
          yield* Effect.logInfo(`turn ${turn.key}: ${turn.transcript}`)
          yield* emit({ type: "ack", key: turn.key })
          yield* FiberSet.run(
            fibers,
            runTurn({ key: turn.key, agentSessionId: turn.agent_session_id, transcript: turn.transcript }, emit).pipe(
              Effect.ensuring(Effect.sync(() => inFlight.delete(turn.key)))
            )
          )
        }),
        steer: Effect.fn("Executor.steer")(function*(msg, emit) {
          // The relay never re-sends a steer, but be safe: one delivery per key.
          if (inFlight.has(msg.key)) return yield* emit({ type: "ack", key: msg.key })
          inFlight.add(msg.key)
          yield* Effect.logInfo(`turn ${msg.key} (steer into ${msg.into}): ${msg.transcript}`)
          yield* emit({ type: "ack", key: msg.key })
          const steers = steerable.get(msg.into)

          if (!steers) {
            // Not running here (finished, or started by an earlier process): no steer to try.
            yield* Effect.logInfo(`turn ${msg.key}: ${msg.into} isn't running, running it on its own`)
            yield* FiberSet.run(
              fibers,
              runTurn({ key: msg.key, agentSessionId: msg.agent_session_id, transcript: msg.transcript }, emit)
            )

            return
          }

          const steer: Steer = { key: msg.key, delivered: Deferred.makeUnsafe() }
          steers.push(steer)
          yield* FiberSet.run(fibers, deliverSteer(msg, steer, emit))
        }),
        sessionOp: Effect.fn("Executor.sessionOp")((op, emit) =>
          FiberSet.run(
            fibers,
            agent.sessionOp(op.op, op.agent_session_id).pipe(
              Effect.map((result): Runner.RunnerMessage => {
                const message: Types.Mutable<Runner.SessionOpResult> = {
                  type: "session_op_result",
                  op_id: op.op_id,
                  agent_session_id: result.agentSessionId
                }

                if (result.context !== undefined) message.context = result.context

                return message
              }),
              Effect.catchTags({
                NotSupported: (e) =>
                  Effect.succeed<Runner.RunnerMessage>({
                    type: "session_op_failed",
                    op_id: op.op_id,
                    code: "not_supported",
                    message: e.message
                  }),
                AgentUnavailable: (e) =>
                  Effect.succeed<Runner.RunnerMessage>({
                    type: "session_op_failed",
                    op_id: op.op_id,
                    code: "agent_failed",
                    message: e.message
                  })
              }),
              Effect.tap((result) => Effect.logInfo(`session ${op.op} (${op.session}) → ${result.type}`)),
              Effect.flatMap(emit)
            )
          ).pipe(Effect.asVoid)
        )
      })
    })
  )
}
