/**
 * The stack's name and its stages. `alchemy.run.ts` picks each stage's state store by them, and the Worker
 * its script name.
 *
 * - `dev_<user>` (`bun run dev`, `alchemy dev`) and `test_<user>` (`Test.make` in `test/workers.test.ts`)
 *   run entirely on this machine: local workerd and `.alchemy/` state, no Cloudflare account.
 * - `prod` is the only deployed stage (`bun run deploy`).
 * - Every other stage fails before anything is planned.
 *
 * The Worker bundles this module, so it imports nothing from Node.
 */

/** The stack's name (`Alchemy.Stack` in `alchemy.run.ts`): the first part of every state path. */
export const STACK = "sideband"

/** The one deployed stage. */
export const PROD = "prod"

/**
 * Prod's Worker script name: the one wrangler deployed before Alchemy, so its workers.dev URL, which the
 * watch and the runner are configured with, stays the same. Local stages keep Alchemy's generated names.
 */
export const PROD_SCRIPT = "sideband"

/** `dev_*` and `test_*` stages run entirely on this machine. */
export const isLocalStage = (stage: string): boolean => /^(dev|test)_/.test(stage)
