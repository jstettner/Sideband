# Sideband

[![CI](https://github.com/jstettner/Sideband/actions/workflows/ci.yml/badge.svg)](https://github.com/jstettner/Sideband/actions/workflows/ci.yml)

Push-to-talk for your AI agent, from an Apple Watch.

Press, speak, lower your wrist, feel the haptic, then read a short answer. Sideband is
a small native watchOS app, a backend that transcribes the audio and relays the turn,
and a runner that sits next to your agent. Hermes is the first agent and Aqua the
first transcription provider. Neither is built into the watch app.

```text
watch ──POST /v1/turn──▶ backend ──▶ transcription provider
                            │
                            ▼  WebSocket (outbound from runner)
                          runner ──▶ agent (local)
```

## Layout

| Path                           | What                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `packages/protocol/`           | The contract: HTTP API (watch ↔ backend), runner WebSocket protocol, shared Effect Schemas |
| `packages/agents/`             | Agents a runner can drive: the `Agent` service, adapters (Echo, Hermes), their contract    |
| `packages/transcription/`      | Speech to text for backends: the `Transcription` service, WAV canonicalization, providers  |
| `watch/`                       | watchOS app + widgets (Swift/SwiftUI, project generated with XcodeGen)                     |
| `packages/backend-cloudflare/` | Reference backend: Cloudflare Worker + Durable Object (Hono + Effect)                      |
| `packages/runner/`             | Long-lived process next to the agent (Bun + Effect)                                        |

Write your own backend or runner against `packages/protocol/`.

## Development

Requirements: [Bun](https://bun.sh), [Node](https://nodejs.org) 22+ (Vitest runs on it), Xcode,
[XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
bun install       # installs, patches TypeScript with @effect/tsgo, clones reference/, and installs git hooks
bun run check     # tsc -b: every package, with the Effect language service diagnostics
bun run lint      # oxlint + dprint check + the openapi.json check (dprint downloads its plugins on first run)
bun run test      # vitest run
bun run format    # dprint fmt
bun run openapi   # regenerate packages/protocol/openapi.json
```

The pre-commit hook (`.githooks/pre-commit`, enabled by `bun install` through `core.hooksPath`) runs
`check`, `lint`, and `test`.

Editor: install the TypeScript 7 (native) extension. `.vscode/settings.json` points it at the
workspace TypeScript so Effect diagnostics show up.

`reference/` holds read-only clones of upstream source (currently Effect, at the tag matching the
root catalog's `effect`) for agents to read; `AGENTS.md` explains them. `bun install` warns and
carries on if it can't reach GitHub to sync them; `bun run reference:sync` retries and fails loudly.
Under `CI`, the sync is skipped.

Local config is never committed. Copy the `*.example` files:

- `packages/backend-cloudflare/.env.example` (Cloudflare account), `.dev.vars.example`
- `packages/runner/.env.example`, `packages/runner/launchd/com.sideband.runner.plist.example`
- `watch/Config/Local.xcconfig.example`

## License

MIT
