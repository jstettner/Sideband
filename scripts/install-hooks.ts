// Points git at the tracked hooks in .githooks/ (`core.hooksPath`), so every clone and worktree runs
// the same pre-commit gate. Runs on every `bun install` (prepare).
//
// Does nothing outside a git checkout (an exported tree, a tarball). Leaves a `core.hooksPath` that is
// already set elsewhere (another hook manager, a global hooks directory) as it is and says so, rather
// than silently turning those hooks off.

import { execFileSync } from "node:child_process"

const HOOKS_PATH = ".githooks"

const git = (...args: ReadonlyArray<string>): string | undefined => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

if (git("rev-parse", "--is-inside-work-tree") === "true") {
  const current = git("config", "--get", "core.hooksPath")

  if (current === undefined || current === "") {
    git("config", "core.hooksPath", HOOKS_PATH)
  } else if (current !== HOOKS_PATH) {
    console.warn(
      `install-hooks: core.hooksPath is already "${current}", so ${HOOKS_PATH}/pre-commit won't run. ` +
        `To use it: git config core.hooksPath ${HOOKS_PATH}`
    )
  }
}
