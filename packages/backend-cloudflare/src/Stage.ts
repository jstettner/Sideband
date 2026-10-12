/**
 * The stack's name and its stages. `alchemy.run.ts` picks each stage's state store by them.
 *
 * - `dev_<user>` (`bun run dev`, `alchemy dev`) and `test_<user>` (`Test.make` in `test/workers.test.ts`)
 *   run entirely on this machine: local workerd and `.alchemy/` state, no Cloudflare account.
 * - Every other stage fails before anything is planned.
 *
 * The Worker bundles this module, so it imports nothing from Node.
 */

/** The stack's name (`Alchemy.Stack` in `alchemy.run.ts`): the first part of every state path. */
export const STACK = "sideband"

/** `dev_*` and `test_*` stages run entirely on this machine. */
export const isLocalStage = (stage: string): boolean => /^(dev|test)_/.test(stage)
