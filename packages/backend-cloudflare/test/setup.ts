// Alchemy captures `process.cwd()` when its modules load and resolves `.alchemy/` (local state, simulator
// storage) from it. Vitest runs from the repo root, so move to this package first, the directory
// `alchemy dev` runs in. Setup files run before the test file's imports.
import * as path from "node:path"

process.chdir(path.join(import.meta.dirname, ".."))
