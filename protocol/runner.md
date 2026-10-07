# Runner protocol

A **runner** runs next to the agent (e.g. on the machine where Hermes lives) and keeps one
outbound WebSocket to the backend's **relay**. The relay pushes turns down it; the runner
executes them against the agent and sends outcomes back. The agent's machine never accepts
inbound connections.

Message schemas: `src/runner.ts`. Examples: `examples/runner/`.

## Connecting

```text
GET /v1/runner/connect
Authorization: Bearer <runner token>
Upgrade: websocket
```

The runner token is separate from client tokens and is the only credential that can receive
turns. A bad token is rejected with `401` before the upgrade.

The relay keeps one runner per user: a new connection replaces the old one, which is closed
with code `4000` (`replaced`). Runners reconnect with exponential backoff (capped at ~30 s) on
any other close.

## Messages

JSON text frames with a `type` field. Unknown fields are ignored; an unknown `type` is logged
and ignored.

```text
runner → relay   hello               protocol version, runner version, agent name, in-flight keys
relay  → runner  turn                key, session, agent_session_id?, transcript
runner → relay   ack                 key
runner → relay   result              key, agent_session_id, watch_text, speak_text?, full_text?, context?
runner → relay   needs_approval      key, agent_session_id, message
runner → relay   turn_failed         key, code (agent_failed | interrupted), message
relay  → runner  session_op          op_id, op (new | compact), session, agent_session_id?
runner → relay   session_op_result   op_id, agent_session_id, context?
runner → relay   session_op_failed   op_id, code (not_supported | agent_failed), message
```

`hello` is the first frame on every connection, including reconnects. If the relay doesn't support its `protocol`
version it closes with `4002` (`unsupported_protocol`).

## Heartbeat

Not JSON: the runner sends the text frame `ping` every 15 s and the relay answers `pong`.
(Fixed strings let a Cloudflare Durable Object answer with `setWebSocketAutoResponse` without
waking up.)

- Runner: no `pong` within 30 s → close and reconnect.
- Relay: last `ping` older than 45 s → treat the runner as offline (`agent_offline` to clients).

## Turns

1. The relay sends `turn`. `key` is the client's `Idempotency-Key`, unchanged.
2. The runner replies `ack` as soon as it has handed the turn to the agent.
3. The runner sends exactly one outcome: `result`, `needs_approval`, or `turn_failed`.

`agent_session_id` in a `turn` is the agent session to continue (absent for a session's first
turn). The outcome reports the session the turn actually ran in, which can differ (the agent
may rotate sessions on compaction); the relay stores it for the next turn.

### Never twice

The runner **must** guarantee a key runs at most once against the agent. Our Hermes adapter
does this by passing `key` as the agent's own idempotency key (Hermes dedups durably). A
runner for an agent without idempotency has to keep its own durable ledger of keys.

### Reconnects

Turns can be in flight when the socket drops. On the next connection:

- The runner lists keys it is still executing in `hello.in_flight`; the relay waits for them.
  (Empty after a fresh process start. Non-empty when only the socket dropped, e.g. on a
  deploy, while the runner was still waiting on the agent. Without it, a long turn would be
  marked `unknown` and its real outcome ignored when it arrives.)
- The runner then sends any outcomes it couldn't deliver. The relay ignores outcomes for keys
  that already have one.
- The relay re-sends turns that have no outcome and aren't in `in_flight`, **if they're
  recent** (ours: under 2 minutes old). Safe because of the at-most-once rule above.
- Older turns are marked `unknown` and not re-sent, so a command never runs late by surprise.

## Session operations

`session_op` asks the runner to start a new agent session (`new`) or compact the current one
(`compact`) behind a session name. The runner answers `session_op_result` with the agent
session ID to use from now on (and context usage, if known), or `session_op_failed`.
`not_supported` maps to the HTTP `501 not_supported` error.
