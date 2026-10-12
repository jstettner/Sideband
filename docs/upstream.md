# Waiting on upstream

Workarounds for upstream bugs and fixes that haven't been released yet, grouped by the dependency that has to
ship. Before bumping one of those pins, check its section for what the new version lets you remove. An entry is
deleted in the same change that removes its workaround.

## Effect

### `@effect/platform-node-shared` held at the catalog's Effect version

- **What:** `overrides` in the root `package.json` pins `@effect/platform-node-shared` to 4.0.2. `@effect/platform-bun`
  4.0.2 depends on it with `^4.0.2`, so a fresh resolve picks 4.0.3, whose `effect` peer is `^4.0.3`: Bun then
  warns about an incorrect peer dependency, and two Effect patch versions meet at runtime.
- **Blocked on:** nothing upstream will fix; this lasts as long as the catalog is on 4.0.2.
- **To remove:** when the catalog moves `effect` and the `@effect/*` packages to 4.0.3 or later, set the override
  to the same version, or delete it if `bun install` resolves `@effect/platform-node-shared` to the catalog's
  version without it.

### `Socket.makeWebSocket` can't send handshake headers

- **What:** `Socket.makeWebSocket` passes only `options.protocols` to the `WebSocketConstructor`, so a client
  can't set `WebSocketClientOptions.headers`, which the Bun and Node constructors support. The runner
  authenticates with an `Authorization` header, so `packages/runner/src/Connection/Connection.ts` calls
  `Socket.WebSocketConstructor` itself and wraps the result with `Socket.fromWebSocket`.
- **Blocked on:** no upstream issue filed yet. Unchanged on Effect `main` as of 2026-10-07.
- **To remove:** once `makeWebSocket` forwards headers, replace the `acquireRelease` and `fromWebSocket` in
  `connectOnce` with `Socket.makeWebSocket(url, { headers })`.
