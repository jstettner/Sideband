import type { Runner } from "@sideband/protocol"
import { Context, Effect, FiberSet, Layer } from "effect"
import { Agent } from "../agent/Agent.ts"

/** Sends a message to the relay (or holds it until the next connection). */
export type Emit = (message: Runner.RunnerMessage) => Effect.Effect<void>

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
  /** Starts a session operation; answers `session_op_result` or `session_op_failed`. */
  readonly sessionOp: (op: Runner.SessionOp, emit: Emit) => Effect.Effect<void>
}>()("sideband/runner/turns/Executor") {
  static readonly layer = Layer.effect(
    Executor,
    Effect.gen(function*() {
      const agent = yield* Agent
      const fibers = yield* FiberSet.make()
      const inFlight = new Set<string>()

      const execute = (turn: Runner.Turn) =>
        agent.runTurn({ key: turn.key, agentSessionId: turn.agent_session_id, transcript: turn.transcript }).pipe(
          Effect.map((outcome): Runner.RunnerMessage => {
            switch (outcome._tag) {
              case "Completed":
                return {
                  type: "result",
                  key: turn.key,
                  agent_session_id: outcome.agentSessionId,
                  watch_text: outcome.watchText,
                  ...(outcome.fullText !== undefined ? { full_text: outcome.fullText } : {}),
                  ...(outcome.context !== undefined ? { context: outcome.context } : {})
                }
              case "NeedsApproval":
                return {
                  type: "needs_approval",
                  key: turn.key,
                  agent_session_id: outcome.agentSessionId,
                  message: outcome.message
                }
              case "Failed":
                return { type: "turn_failed", key: turn.key, code: outcome.code, message: outcome.message }
            }
          }),
          Effect.catchTag("AgentUnavailable", (e): Effect.Effect<Runner.RunnerMessage> =>
            Effect.logWarning(`turn ${turn.key}: ${e.message}`).pipe(
              Effect.as({ type: "turn_failed", key: turn.key, code: "agent_failed", message: e.message })
            )),
          // Interruption (shutdown) is not an outcome: the relay re-sends the turn to the next process.
          Effect.catchDefect((defect) =>
            Effect.logError(`turn ${turn.key} crashed`, defect).pipe(
              Effect.as<Runner.RunnerMessage>({
                type: "turn_failed",
                key: turn.key,
                code: "agent_failed",
                message: "The agent couldn't run this command."
              })
            )
          )
        )

      return Executor.of({
        inFlight: Effect.sync(() => [...inFlight]),
        run: (turn, emit) =>
          Effect.gen(function*() {
            // A turn the relay re-sent while we're still running it: the running one will answer.
            if (inFlight.has(turn.key)) return yield* emit({ type: "ack", key: turn.key })
            inFlight.add(turn.key)
            yield* Effect.logInfo(`turn ${turn.key}: ${turn.transcript}`)
            yield* emit({ type: "ack", key: turn.key })
            yield* FiberSet.run(
              fibers,
              execute(turn).pipe(
                Effect.tap((outcome) => Effect.logInfo(`turn ${turn.key} → ${outcome.type}`)),
                Effect.flatMap(emit),
                Effect.ensuring(Effect.sync(() => inFlight.delete(turn.key)))
              )
            )
          }),
        sessionOp: (op, emit) =>
          FiberSet.run(
            fibers,
            agent.sessionOp(op.op, op.agent_session_id).pipe(
              Effect.map((result): Runner.RunnerMessage => ({
                type: "session_op_result",
                op_id: op.op_id,
                agent_session_id: result.agentSessionId,
                ...(result.context !== undefined ? { context: result.context } : {})
              })),
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
      })
    })
  )
}
