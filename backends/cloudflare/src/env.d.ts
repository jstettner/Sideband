// Bindings and secrets (`.dev.vars` locally, `wrangler secret put` in production).
declare namespace Cloudflare {
  interface Env {
    readonly WATCH_TOKEN: string
    readonly RUNNER_TOKEN: string
    readonly AQUA_API_KEY: string
  }
}
