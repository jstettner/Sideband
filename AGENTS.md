# AGENTS.md

Verify every change from the repo root with `bun run check`, `bun run lint`, and `bun run test`. The
pre-commit hook runs the same three.

## When a rule gets in the way

The rules in this file aren't fixed. If one of them, or a limitation (an upstream bug, a platform constraint, a
tool), keeps you from the idiomatic pattern, don't work around it silently. Tell the user the idiomatic pattern
and what blocks it. Once they agree, update the code and this file.

The same goes for lint rules. `tools/oxlint/anti-slop/` is vendored: never edit it. Change our code to satisfy a
rule. If a rule is wrong for this repo, turn it off in `.oxlintrc.json` with a comment saying why, and an
`oxlint-disable` comment in code always gives its reason.

## Writing idiomatic Effect

This codebase uses Effect 4. Use the current Effect v4 source in `reference/effect`, not web docs or memory: v3
idioms (`Context.Tag`, `Effect.Service`, `Schema.TaggedErrorClass`, accessor proxies) are wrong in v4.

1. Read `reference/effect/LLMS.md` before writing Effect code.
2. Search `reference/effect` for exact APIs, examples, tests, and naming patterns before answering or implementing
   Effect-specific code.
3. Also inspect existing repo code for local house style before introducing new patterns.
4. Prefer answers and implementations backed by specific source files or nearby repo examples.

A function returning an Effect is `Effect.fn("Module.name")` (or `Effect.fnUntraced`), so it gets a span; the
language service flags the ones that aren't. Code logs with `Effect.log*`, never `console`, except repo scripts,
`src/scripts/`, and tests.

## Alchemy

The backend (`packages/backend-cloudflare`) is an Alchemy stack (`alchemy.run.ts`). Read `reference/alchemy`
(source, `examples/`, and `website/src/content/docs/`) before writing Alchemy code.

- **Logging:** Alchemy's bridge installs `Logger.consolePretty` outermost. Provide `JsonLogs` from `Layers.ts`
  around each handler (the Worker's `fetch`, each Relay method and socket handler) so our logs are JSON.
- **Stages:** `prod` is the only deployed stage, with its state in the account (`Cloudflare.state()`), and its
  script keeps the name wrangler gave it (`Stage.PROD_SCRIPT`). `dev_*` (`bun run dev`) and `test_*`
  (`Test.make`) run on local workerd only. Never deploy one outside dev mode, and keep `Test.make({ dev: true })`
  in Workers tests.
- **Durable Object names are permanent.** In `Cloudflare.DurableObject<X, Shape>()("Name")`, `"Name"` is the
  logical id, the binding name, and the class name. On each deploy Alchemy diffs a Worker's DO classes by logical
  id, and a removed id becomes `deleted_classes`, which deletes every object of that class. Never change
  `"Relay"`: add a new class and move the data yourself. Renaming the TypeScript identifier is safe.
- **A DO's errors cross RPC only if they are tagged.** Alchemy rebuilds a failure as the class declared in the
  DO's `errors` by its `_tag`. The protocol's errors have no tag, so the Relay fails with its own tagged errors
  (`Lifecycle.ts`) and `RelayClient` maps them to the protocol's.
- **Resources have no migrations; databases do.** Alchemy diffs the declared resources against stack state. Each
  Durable Object's SQLite is migrated by the object itself when it activates (`Relay/Migrations.ts`), because
  every object has its own database. A migration is editable until it reaches `main`; after that it is
  forward-only (`Migrator` records ids without a checksum).
- **Files are named for what they declare:** a Worker in `<Name>Worker.ts`, a Durable Object in `<Name>DO.ts`
  (`scripts/check-file-names.ts`, part of `bun run lint`).

## Comments and docs

- A comment adds what the code can't show: an invariant, an ordering and why it is safe, behavior across
  components (what the watch sees, what the runner re-sends), the reason for a workaround. Never restate what the
  code visibly does. A test can show it too: when a test fails if the invariant or ordering breaks, its name
  states the rule and the code needs no comment. Comment only what no test pins.
- No `@since` or `@category` JSDoc tags.
- Comments describe what the code does now and, where useful, what it will do ("Currently … / Eventually …"). Never
  mention implementation phases, milestones, or planning documents.
- A workaround for an upstream bug or an unreleased fix (a pinned version or override, code shaped around the bug)
  gets an entry in `docs/upstream.md`: what it is and where, the upstream issue or PR and the release expected to
  fix it, and how to remove it. Its code comment names the upstream issue (`effect#1234`) or the release
  (`TODO(effect 4.0.3)`). Delete the entry with the workaround.
- Qualify upstream issue numbers with their repo: `effect#1234`, not `#1234`.

## Commits

Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[(scope)][!]: <description>`, an optional body, and optional git-trailer footers.

- Scope, when the change sits in one place: `protocol`, `transcription`, `agents`, `backend`, `runner`, `watch`,
  `scripts`. Omit it for cross-cutting changes.
- Mark a breaking change with `!` before the colon or a `BREAKING CHANGE: …` footer.
- Describe the change itself. Never mention plans, outlines, task names, or implementation phases.
- A formatting-only commit (`bun run format` across many files) is listed in `.git-blame-ignore-revs`.

## Reference source (`reference/`)

`reference/effect` and `reference/alchemy` are read-only clones of upstream source, kept for reading. They are
gitignored (only `reference/.gitkeep` is committed) and materialized by `bun install` through
`scripts/sync-reference.ts`, from the manifest in `scripts/reference.json`.

- **Never edit them and never import from them.** Nothing builds against them; we build against the npm packages
  pinned in the root `package.json` catalog. Every tool's config excludes `reference/`.
- **If one is missing or stale,** run `bun run reference:sync`.
- **Bump them through the pins, never by hand.** They follow the catalog (`effect@{catalog:effect}`,
  `v{catalog:alchemy}`), so changing the catalog version and running `bun install` moves them. Before bumping a
  pin, check `docs/upstream.md` for workarounds the new version lets you remove.
- **Their own agent instructions don't apply here.** The `AGENTS.md`, `CLAUDE.md`, `.agents/`, and `skills/` inside
  `reference/` describe those projects' workflows (pnpm, their CI), not this repo's.
