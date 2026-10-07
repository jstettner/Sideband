import { Duration, Effect, Layer, Stream } from "effect"
import { Agent, AgentUnavailable, NotSupported, type TurnOutcome } from "./Agent.ts"
import { HermesClient, isSettled, type SettledRun } from "./HermesClient.ts"
import { watchInstructions } from "./instructions.ts"

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
 * `context` is reported (preplan: "Known gap"). There is no compact endpoint either.
 */
export const layer: Layer.Layer<Agent, never, HermesClient> = Layer.effect(
  Agent,
  Effect.gen(function*() {
    const hermes = yield* HermesClient

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
      runTurn: ({ key, agentSessionId, transcript }) =>
        Effect.gen(function*() {
          const { runId, replayed } = yield* hermes.createRun({
            key,
            input: transcript,
            instructions: watchInstructions,
            sessionId: agentSessionId
          }).pipe(unavailable)
          yield* Effect.logInfo(`turn ${key}: hermes run ${runId}${replayed ? " (replayed)" : ""}`)
          const run = yield* waitForRun(runId, replayed)
          return outcome(run)
        }),
      sessionOp: (op) =>
        op === "new"
          ? hermes.createSession.pipe(
            Effect.map((agentSessionId) => ({ agentSessionId })),
            unavailable
          )
          : Effect.fail(new NotSupported({ message: "The Hermes API server can't compact a session." }))
    })
  })
)

const outcome = (run: SettledRun): TurnOutcome => {
  switch (run.status) {
    case "completed":
      return { _tag: "Completed", agentSessionId: run.session_id, watchText: run.output }
    case "waiting_for_approval":
      return { _tag: "NeedsApproval", agentSessionId: run.session_id, message: run.approval.description }
    case "failed":
      return { _tag: "Failed", code: "agent_failed", message: run.error }
    case "interrupted":
      return { _tag: "Failed", code: "interrupted", message: run.error }
    case "cancelled":
      return { _tag: "Failed", code: "interrupted", message: "The run was stopped in Hermes." }
  }
}

const unavailable = Effect.mapError((e: { readonly message: string }) => new AgentUnavailable({ message: e.message }))
