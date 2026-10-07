import { AgentOffline, DEFAULT_SESSION, NotSupported, SidebandApi } from "@sideband/protocol"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"

// Placeholders until the relay tracks runners and sessions (Milestone 3).

const status = HttpApiBuilder.group(SidebandApi, "status", (handlers) =>
  handlers.handle("get", ({ query }) =>
    Effect.succeed({
      agent: { name: "agent", online: false },
      session: { name: query.session ?? DEFAULT_SESSION, busy: false }
    })))

const sessions = HttpApiBuilder.group(SidebandApi, "sessions", (handlers) =>
  handlers
    .handle("new", () =>
      Effect.fail(new AgentOffline({ error: "agent_offline", message: "no runner connected", retryable: true })))
    .handle("compact", () =>
      Effect.fail(new NotSupported({ error: "not_supported", message: "not implemented yet", retryable: false }))))

export const layer = Layer.mergeAll(status, sessions)
