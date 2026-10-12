// Bindings and secrets (`.dev.vars` locally, `wrangler secret put` in production).
declare namespace Cloudflare {
  interface Env {
    readonly RELAY: DurableObjectNamespace<import("./Relay/Relay.ts").Relay>
    readonly WATCH_TOKEN: string
    readonly RUNNER_TOKEN: string
    readonly AQUA_API_KEY: string
  }
}
