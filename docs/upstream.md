# Waiting on upstream

Workarounds for upstream bugs and fixes that haven't been released yet, grouped by the dependency that has to
ship. Before bumping one of those pins, check its section for what the new version lets you remove. An entry is
deleted in the same change that removes its workaround.

## Alchemy

### JSON logs need a provide around every handler

- **What:** `JsonLogs` in `packages/backend-cloudflare/src/Layers.ts`, provided around the Worker's `fetch` and
  its router's construction (`serve` in `Sideband/SidebandWorker.ts`), and around each Relay method and socket
  handler (`Relay/RelayDO.ts`). Alchemy's Worker bridge installs `Logger.consolePretty` as the outermost logger,
  so each handler has to override it from the inside; HttpApi handlers keep the context their router was built
  in, so the build needs it too.
- **Blocked on:** alchemy#1954 (open, no fix yet).
- **To remove:** once the bridge lets a Worker choose its logger, choose `Logger.consoleJson` once, delete the
  per-handler provides, and update the logging rule in `AGENTS.md`.

### Compatibility date pinned to `2026-09-25`

- **What:** `compatibility: { date: "2026-09-25" }` in `packages/backend-cloudflare/src/Sideband/SidebandWorker.ts`.
  That is the newest date the workerd bundled with alchemy@2.0.0-beta.81 supports, and local dev refuses later
  ones.
- **Blocked on:** an Alchemy release that bundles a newer workerd.
- **To remove:** after bumping Alchemy, move the date to the newest the new workerd supports and update the
  comment.
