// `bun run dev`: runs `alchemy dev` in this package (Alchemy resolves `.alchemy/` and `.env` from its
// working directory), on Alchemy's default local stage, `dev_$USER`. Extra arguments pass through:
// `bun run dev -- --env-file ../../.env.dev`.

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const packageRoot = resolve(import.meta.dirname, "../..")

const result = spawnSync("bunx", ["alchemy", "dev", ...process.argv.slice(2)], { cwd: packageRoot, stdio: "inherit" })

if (result.error) process.stderr.write(`dev: could not start alchemy: ${result.error.message}\n`)

process.exit(result.status ?? 1)
