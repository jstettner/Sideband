/**
 * The `sideband` stack: the `Sideband` Worker and the `Relay` Durable Object it hosts.
 *
 * Each stage picks its state store here (`src/Stage.ts`):
 * - `dev_*` (`bun run dev`) and `test_*` (`Test.make`): `localState()`, under this package's
 *   `.alchemy/state/sideband/<stage>/`. No Cloudflare account, credentials, or network.
 * - `prod` (`bun run deploy`): the account's `Cloudflare.state()`. Never `localState()`, which would write
 *   deploy-time secrets (the Worker's tokens) to disk in plaintext.
 * - Any other stage fails before anything is planned.
 *
 * The Relay migrates its own SQLite when each object activates, so the stack has no migrate step.
 */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import SidebandWorkerLive, { SidebandWorker } from "./src/Sideband/SidebandWorker.ts"
import { isLocalStage, PROD, STACK } from "./src/Stage.ts"

/** Each configured stage's state store. */
const stageState = (stage: string) => {
  if (isLocalStage(stage)) return Alchemy.localState()

  if (stage === PROD) return Cloudflare.state()

  return undefined
}

/**
 * The stage Alchemy's own tooling runs under (`PLACEHOLDER_STAGE` in alchemy's `Alchemist/Session.ts`),
 * for commands that take no `--stage` (`alchemy profile`, `alchemy state` without `--backend`). Alchemy
 * doesn't export the constant, so it is matched by value here.
 */
const ALCHEMY_TOOLING_STAGE = "placeholder"

/** {@link stageState} for the current stage, failing for a stage that has none. */
const currentState = Effect.flatMap(Alchemy.Stage, (stage) => {
  const state = stageState(stage)

  if (state !== undefined) return Effect.succeed(state)

  return Effect.die(
    new Error(
      stage === ALCHEMY_TOOLING_STAGE
        ? "This alchemy command runs without a stage, and this stack picks its state store per stage. For " +
          "`alchemy state`, name the store: `--backend cloudflare` (prod) or `--backend local` (dev_*, test_*)"
        : `Stage "${stage}" is not configured in alchemy.run.ts: use \`bun run dev\` (dev_*), \`bun run test\` ` +
          "(test_*), or `bun run deploy` (prod)"
    )
  )
})

// The state layer is built in a context that already has `Stage`, so it can branch on it. Alchemy's tooling
// stage gets local state (nothing is ever written under it); any other unconfigured stage fails here.
const StackState = Layer.unwrap(
  Effect.flatMap(Alchemy.Stage, (stage) =>
    stage === ALCHEMY_TOOLING_STAGE
      ? Effect.succeed(Alchemy.localState())
      : currentState)
)

export default Alchemy.Stack(
  STACK,
  { providers: Cloudflare.providers(), state: StackState },
  Effect.gen(function*() {
    // Fails an unconfigured stage before anything is planned.
    yield* currentState
    const worker = yield* SidebandWorker

    return { url: worker.url }
  }).pipe(Effect.provide(SidebandWorkerLive))
)
