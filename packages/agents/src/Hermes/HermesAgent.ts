import { Duration, Effect, Layer, Stream } from "effect"
import { Agent, AgentUnavailable, NotSupported, TurnOutcome } from "../Agent/Agent.ts"
import { HermesClient, isSettled, type SettledRun } from "./HermesClient.ts"
import { watchInstructions } from "./Instructions.ts"

/** For replayed runs and lost event streams (see `waitForRun`). */
const POLL_INTERVAL = Duration.seconds(1)

/** Events after which the run's status is settled (Hermes updates the status before emitting). */
const SETTLING_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "approval.request"])

/**
 * Hermes through its API server. A turn is one `/v1/runs` run with the turn key as
 * `Idempotency-Key`, so a re-sent turn attaches to the original run instead of starting another.
 * The run's event stream says when it settles or stops for an approval.
 *
 * `usage` on a run is cumulative session throughput, not context-window occupancy, so no
 * `context` is reported. There is no compact endpoint either.
 */
export const layer: Layer.Layer<Agent, never, HermesClient> = Layer.effect(
  Agent,
  Effect.gen(function*() {
    const hermes = yield* HermesClient
    /** Run of each turn this process is waiting on, by turn key: steers go to it. */
    const runs = new Map<string, string>()

    /**
     * Waits for the run to settle. The status (`GET /v1/runs/{id}`) is the source of truth, the
     * event stream only says when to read it.
     *
     * Hermes buffers a run's events in one in-memory queue from admission on, shared by all
     * `/events` readers, and only notices a dead reader when it writes to it. A dead reader
     * swallows the events, end included, and a later reader waits forever. So:
     *
     * - A new run: only we know its ID, so follow its stream until a settling event or its end.
     *   If our connection drops, Hermes deletes the stream; the status read below then polls.
     * - A replayed run (a re-sent turn, e.g. after a runner restart): an earlier reader may still
     *   hold its stream, so don't follow it; poll. The run may also have settled long ago.
     *
     * A gateway restart fails the run as `interrupted`; the status read retries until it's back.
     */
    const waitForRun = (runId: string, replayed: boolean): Effect.Effect<SettledRun, AgentUnavailable> =>
      Effect.gen(function*() {
        if (!replayed) {
          yield* hermes.runEvents(runId).pipe(
            Stream.takeUntil((event) => SETTLING_EVENTS.has(event)),
            Stream.runDrain,
            Effect.catchTag("HermesError", (e) => Effect.logWarning(`run ${runId}: events lost, polling: ${e.message}`))
          )
        }

        while (true) {
          const run = yield* hermes.getRun(runId).pipe(unavailable)

          if (isSettled(run)) return run
          yield* Effect.sleep(POLL_INTERVAL)
        }
      })

    return Agent.of({
      name: "hermes",
      runTurn: Effect.fn("Hermes.runTurn")(function*({ key, agentSessionId, transcript }) {
        const { runId, replayed } = yield* hermes.createRun({
          key,
          input: transcript,
          instructions: watchInstructions,
          sessionId: agentSessionId
        }).pipe(unavailable)

        yield* Effect.logInfo(`hermes run ${runId}${replayed ? " (replayed)" : ""}`)
        runs.set(key, runId)
        const run = yield* waitForRun(runId, replayed).pipe(Effect.ensuring(Effect.sync(() => runs.delete(key))))

        return outcome(run)
      }),
      steerTurn: Effect.fn("Hermes.steerTurn")(({ key, transcript }) => {
        const runId = runs.get(key)

        if (runId === undefined) return Effect.succeed("NotRunning" as const)

        return hermes.steerRun(runId, transcript).pipe(
          Effect.tap((result) => Effect.logInfo(`turn ${key}: steer into hermes run ${runId} → ${result}`)),
          unavailable
        )
      }),
      sessionOp: Effect.fn("Hermes.sessionOp")(function*(op) {
        if (op !== "new") {
          return yield* new NotSupported({ message: "The Hermes API server can't compact a session." })
        }

        const agentSessionId = yield* hermes.createSession.pipe(unavailable)

        return { agentSessionId }
      })
    })
  })
)

const { Completed, NeedsApproval, Failed } = TurnOutcome.cases

const outcome = (run: SettledRun): TurnOutcome => {
  switch (run.status) {
    case "completed":
      return Completed.make({ agentSessionId: run.session_id, watchText: run.output, pendingSteer: run.pending_steer })
    case "waiting_for_approval":
      return NeedsApproval.make({ agentSessionId: run.session_id, message: run.approval.description })
    case "failed":
      return Failed.make({ code: "agent_failed", message: run.error })
    case "interrupted":
      return Failed.make({ code: "interrupted", message: run.error })
    case "cancelled":
      return Failed.make({ code: "interrupted", message: "The run was stopped in Hermes." })
  }
}

const unavailable = Effect.mapError((e: { readonly message: string }) => new AgentUnavailable({ message: e.message }))
