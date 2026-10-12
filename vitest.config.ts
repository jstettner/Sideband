import * as path from "node:path"
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"

// Shaped like reference/effect/vitest.config.ts: one project per package (plus the repo scripts).
// reference/ is never a project, so its tests never run.

const exclude = ["**/node_modules/**", "**/.alchemy/**", "**/.tsbuild/**", "**/reference/**"]

const shared: ViteUserConfig = {
  test: {
    exclude,
    setupFiles: [path.join(import.meta.dirname, "vitest.setup.ts")],
    include: ["test/**/*.test.ts"]
  }
}

const project = (name: string, directory: string, config: ViteUserConfig = {}): ViteUserConfig =>
  mergeConfig(shared, mergeConfig({ root: path.join(import.meta.dirname, directory), test: { name } }, config))

export default defineConfig({
  test: {
    projects: [
      project("@sideband/protocol", "packages/protocol"),
      project("@sideband/transcription", "packages/transcription"),
      project("@sideband/agents", "packages/agents"),
      project("@sideband/runner", "packages/runner"),
      project("@sideband/backend-cloudflare", "packages/backend-cloudflare", {
        test: {
          // Alchemy resolves `.alchemy/` (state and local simulator data) from the working directory, so run
          // this project from packages/backend-cloudflare, as `alchemy dev` does.
          setupFiles: [path.join(import.meta.dirname, "packages/backend-cloudflare/test/setup.ts")],
          // alchemy/Test/Vitest registers a fallback `afterAll` that closes its dev sidecar, and relies on it
          // running after the file's own `afterAll(destroy(Stack))`. Vitest's default `"stack"` order runs
          // after-hooks in reverse, closing the sidecar first so `destroy` hangs.
          sequence: { hooks: "list" },
          // Booting workerd and bundling the Worker takes a while on a cold cache.
          testTimeout: 120_000,
          hookTimeout: 300_000
        }
      }),
      project("scripts", "scripts", { test: { include: ["*.test.ts"] } })
    ]
  }
})
