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

`reference/effect` is a read-only clone of upstream source, kept for reading. It is gitignored (only
`reference/.gitkeep` is committed) and materialized by `bun install` through `scripts/sync-reference.ts`, from the
manifest in `scripts/reference.json`.

- **Never edit it and never import from it.** Nothing builds against it; we build against the npm packages pinned
  in the root `package.json` catalog. Every tool's config excludes `reference/`.
- **If it is missing or stale,** run `bun run reference:sync`.
- **Bump it through the pin, never by hand.** `reference/effect` follows the catalog (`effect@{catalog:effect}`),
  so changing the catalog version and running `bun install` moves it. Before bumping a pin, check
  `docs/upstream.md` for workarounds the new version lets you remove.
- **Its own agent instructions don't apply here.** The `AGENTS.md`, `CLAUDE.md`, `.agents/`, and `skills/` inside
  `reference/` describe that project's workflow (pnpm, its CI), not this repo's.
