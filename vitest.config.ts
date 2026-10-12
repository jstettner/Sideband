import * as path from "node:path"
import { defineConfig, mergeConfig, type ViteUserConfig } from "vitest/config"

// Shaped like reference/effect/vitest.config.ts: one project per package (plus the repo scripts).
// reference/ is never a project, so its tests never run.

const exclude = ["**/node_modules/**", "**/.wrangler/**", "**/.tsbuild/**", "**/reference/**"]

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
      project("@sideband/runner", "packages/runner"),
      project("@sideband/backend-cloudflare", "packages/backend-cloudflare"),
      project("scripts", "scripts", { test: { include: ["*.test.ts"] } })
    ]
  }
})
