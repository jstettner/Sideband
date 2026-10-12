/**
 * Answers with the transcript. No side effects, so it needs no idempotency ledger: a re-sent key
 * gets the same answer.
 *
 * With `SIDEBAND_ECHO_DELAY_MS`, a turn takes that long and can be steered meanwhile: steers are
 * added to the answer, except those in the last quarter of the delay, which come back as
 * `pendingSteer` (like Hermes when the final reply is already being written).
 */
import { Clock, Config, Effect, Layer } from "effect"
import { Agent, NotSupported, TurnOutcome } from "../Agent/Agent.ts"

/** `delayMs` > 0 makes turns take that long, so steering can be tried locally. */
export const config = Config.all({
  delayMs: Config.Int("SIDEBAND_ECHO_DELAY_MS").pipe(Config.withDefault(0))
})

export const layer = (options: Config.Success<typeof config>): Layer.Layer<Agent> =>
  Layer.sync(Agent, () => {
    const running = new Map<string, { readonly lateAt: number; steers: Array<string>; late: Array<string> }>()

    return Agent.of({
      name: "echo",
      runTurn: Effect.fn("Echo.runTurn")(function*({ key, agentSessionId, transcript }) {
        const turn = { lateAt: (yield* Clock.currentTimeMillis) + options.delayMs * 0.75, steers: [], late: [] }
        running.set(key, turn)
        yield* Effect.sleep(options.delayMs).pipe(Effect.ensuring(Effect.sync(() => running.delete(key))))

        return TurnOutcome.cases.Completed.make({
          // A session's first turn names the session after itself, so a re-sent key gets the same one.
          agentSessionId: agentSessionId ?? `echo-${key}`,
          watchText: [transcript, ...turn.steers.map((steer) => `+ ${steer}`)].join("\n"),
          pendingSteer: turn.late.length > 0 ? turn.late.join("\n") : undefined
        })
      }),
      steerTurn: Effect.fn("Echo.steerTurn")(function*({ key, transcript }) {
        const turn = running.get(key)

        if (!turn) return "NotRunning" as const

        if ((yield* Clock.currentTimeMillis) < turn.lateAt) turn.steers.push(transcript)
        else turn.late.push(transcript)

        return "Steered" as const
      }),
      sessionOp: Effect.fn("Echo.sessionOp")(function*(op) {
        if (op !== "new") return yield* new NotSupported({ message: "echo has no context to compact" })

        return { agentSessionId: `echo-${crypto.randomUUID()}` }
      })
    })
  })

/** {@link layer} with its {@link config} read from the host's environment. */
export const layerConfig: Layer.Layer<Agent, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    return layer(yield* config)
  })
)
