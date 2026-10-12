# Architecture

How the pieces fit, the stages the backend runs on, and how a turn moves through the relay. The rules that keep
it this way are in `AGENTS.md`; the wire contract is `packages/protocol` (`openapi.json` and `runner.md`).

## Topology

```text
watch ── HTTPS, watch token ──▶ Sideband Worker ──▶ Aqua (transcription, audio turns)
                                     │
                                     │ Durable Object RPC (RelayClient)
                                     ▼
                                Relay Durable Object "owner"
                                SQLite: turns, sessions, relay_meta
                                     ▲
                                     │ WebSocket via /v1/runner/connect, opened by the runner (runner token)
                                     │
                                  runner ──▶ agent (Echo, Hermes)
```

- The watch talks only to the Worker. An audio turn is transcribed in the Worker, before the relay sees it.
- The Worker calls the Relay over Durable Object RPC (`RelayClient`); the runner's WebSocket is accepted by
  the Relay itself (hibernatable, heartbeats answered without waking it).
- The runner keeps the only connection to the agent's machine, outbound. It runs each turn against the agent
  through an adapter from `@sideband/agents`.
- One user: one watch token, one runner token, one relay named `"owner"`.

## Stages

| Stage        | Where                         | State                                | Used by                  |
| ------------ | ----------------------------- | ------------------------------------ | ------------------------ |
| `dev_$USER`  | local workerd (`alchemy dev`) | `.alchemy/` in the backend package   | `bun run dev`            |
| `test_$USER` | local workerd                 | `.alchemy/` in the backend package   | `bun run test` (Workers) |
| `prod`       | Cloudflare                    | `Cloudflare.state()`, in the account | `bun run deploy`         |

`alchemy.run.ts` fails any other stage before it plans anything. Each Relay object migrates its own SQLite when
it activates (`Relay/Migrations.ts`), so a deploy has no migration step.

## A turn's lifecycle

A turn is one row of the relay's `turns` table, keyed by the client's `Idempotency-Key`.

```text
              submit                 runner acks           outcome (result, needs_approval,
(new key) ─────────────▶  sent  ─────────────────▶  acked ─────── turn_failed, merged) ───▶  done
                           │  ▲                       │
                           │  └── hello re-sends ─────┘  (younger than the re-send window, not in flight)
                           │                          │
                           └──────────┬───────────────┘
                                      │ runner gone past the re-send window
                                      ▼
                                   unknown  (lost: may or may not have run; never run again)
```

- Only a `done` turn has an outcome; the row's type (`Lifecycle.TurnRow`) and a table check both say so.
- `done` and `unknown` are final: duplicate outcomes are ignored, and the turn is pruned seven days later.
- The client sees `running` until the turn is final (`Lifecycle.turnState`); `submit` holds the request open
  for up to 25 s first.

### Sessions and steering

A session (`main`, by default) runs one turn at a time: its `active_key`. A turn submitted while another is
active is sent as a **steer** into it (protocol 2), or refused with `session_busy` (protocol 1). A steer is
answered through the turn it joined (`merged`), or runs as its own turn if it arrived too late. When the active
turn resolves, the latest open steer into it becomes the active turn.

### Every event, one way

The Relay handles every event (a client request, a runner frame, the daily alarm) the same way:

```text
read   the rows the event touches            Lifecycle.read     (Store.ts, SQLite)
step   (slice, event, now) → writes,         Lifecycle.<event>  (pure)
       commands, answer
save   the writes, in the same transaction   Store.save
act    send frames, wake waiting requests,   RelayDO.ts
       answer session ops, set the alarm
```

Save comes before act. If the object dies between them, its socket dies too; the runner reconnects with
`hello`, and the `hello` step re-sends what it must.
