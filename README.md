# Sideband

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

| Path | What |
| --- | --- |
| `protocol/` | The contract: HTTP API (watch ↔ backend), runner WebSocket protocol, shared Effect Schemas |
| `watch/` | watchOS app + widgets (Swift/SwiftUI, project generated with XcodeGen) |
| `backends/cloudflare/` | Reference backend: Cloudflare Worker + Durable Object (Hono + Effect) |
| `runner/` | Long-lived process next to the agent (Bun + Effect), with agent adapters |

Write your own backend or runner against `protocol/`.

## Development

Requirements: [Bun](https://bun.sh), Xcode, [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```sh
bun install          # also patches tsc with the Effect language service
bun run typecheck
```

Editor: install the TypeScript 7 (native) extension. `.vscode/settings.json` points it at the
workspace TypeScript so Effect diagnostics show up.

Optional, for AI-assisted development: `CLAUDE.md` points agents at a local checkout of the
Effect v4 source ([effect.solutions setup](https://www.effect.solutions/project-setup#reference-repositories)):

```sh
git clone --depth 1 https://github.com/Effect-TS/effect.git ~/.local/share/effect-solutions/effect
```

Local config is never committed. Copy the `*.example` files:

- `backends/cloudflare/wrangler.toml.example`, `.dev.vars.example`
- `runner/.env.example`, `runner/launchd/com.sideband.runner.plist.example`
- `watch/Config/Local.xcconfig.example`

## License

MIT
