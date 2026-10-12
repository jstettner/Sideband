// Materializes the gitignored reference/ directory: read-only clones of upstream
// source (Effect, and later Alchemy) that agents read as the source of truth for
// APIs and idioms. Nothing builds against them.
//
// The manifest (scripts/reference.json) pins each entry either by `sha` or by a
// `ref` tag template whose `{catalog:<name>}` placeholders are filled from the root
// package.json catalog, so bumping a catalog pin and running `bun install` moves
// the matching reference with it.
//
// Runs on every `bun install` (postinstall). In that mode failures warn and exit 0:
// the clones are reference material, not build inputs, and an offline install must
// still succeed. Under CI it is skipped unless --force is passed.
// `bun run reference:sync` passes --force, which fails loudly instead.

import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

const Sparse = Schema.optionalKey(Schema.Array(Schema.NonEmptyString))

/** Pinned to an exact commit (repos with no npm package to follow). */
const ShaEntry = Schema.Struct({ url: Schema.NonEmptyString, sha: Sha, sparse: Sparse })

/** Pinned to a tag, e.g. `effect@{catalog:effect}` → `effect@4.0.2`. */
const RefEntry = Schema.Struct({ url: Schema.NonEmptyString, ref: Schema.NonEmptyString, sparse: Sparse })

export const ReferenceEntry = Schema.Union([ShaEntry, RefEntry])

export type ReferenceEntry = typeof ReferenceEntry.Type

export const ReferenceManifest = Schema.Record(Schema.String, ReferenceEntry)

export type ReferenceManifest = typeof ReferenceManifest.Type

const RootPackageJson = Schema.Struct({
  workspaces: Schema.Struct({ catalog: Schema.Record(Schema.String, Schema.String) })
})

export type Catalog = Readonly<Record<string, string>>

export type SyncResult = "up-to-date" | "updated" | "cloned"

/** What a clone is checked out at: a commit, or a tag fetched as `refs/tags/<tag>`. */
export type Target =
  | { readonly kind: "sha"; readonly sha: string }
  | { readonly kind: "tag"; readonly tag: string }

const git = (args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

export const loadManifest = (manifestPath: string): ReferenceManifest =>
  Schema.decodeUnknownSync(ReferenceManifest)(JSON.parse(readFileSync(manifestPath, "utf8")))

export const loadCatalog = (packageJsonPath: string): Catalog =>
  Schema.decodeUnknownSync(RootPackageJson)(JSON.parse(readFileSync(packageJsonPath, "utf8"))).workspaces.catalog

/** Fills every `{catalog:<name>}` placeholder from the catalog; an unknown name is an error. */
export const resolveRefTemplate = (template: string, catalog: Catalog): string =>
  template.replace(/\{catalog:([^}]+)\}/g, (_, name: string) => {
    const version = catalog[name]

    if (version === undefined) {
      throw new Error(`ref template "${template}" names "${name}", which is not in the root catalog`)
    }

    return version
  })

export const resolveTarget = (entry: ReferenceEntry, catalog: Catalog): Target =>
  "sha" in entry ? { kind: "sha", sha: entry.sha } : { kind: "tag", tag: resolveRefTemplate(entry.ref, catalog) }

export const describeTarget = (target: Target): string => target.kind === "sha" ? target.sha.slice(0, 12) : target.tag

// The recorded fingerprint covers everything that changes the checked-out tree, so a
// changed URL alone doesn't force a re-fetch but a changed target or sparse set does.
const fingerprint = (target: Target, sparse: ReadonlyArray<string> | undefined): string =>
  JSON.stringify({ target, sparse: sparse ?? null })

const FINGERPRINT_KEY = "sideband.reference"

/** The fingerprint recorded by the last successful sync, or null if the clone is missing or broken. */
export const recordedFingerprint = (dir: string): string | null => {
  if (!existsSync(resolve(dir, ".git"))) return null

  try {
    // A readable HEAD guards against an interrupted clone that recorded nothing usable.
    git(["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"])

    return git(["-C", dir, "config", "--local", "--get", FINGERPRINT_KEY])
  } catch {
    return null
  }
}

export const syncEntry = (root: string, prefix: string, entry: ReferenceEntry, catalog: Catalog): SyncResult => {
  const dir = resolve(root, prefix)
  const target = resolveTarget(entry, catalog)
  const expected = fingerprint(target, entry.sparse)

  if (recordedFingerprint(dir) === expected) return "up-to-date"

  let result: SyncResult

  if (existsSync(resolve(dir, ".git"))) {
    result = "updated"
  } else {
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      throw new Error(`${prefix} exists but is not a git clone; remove it and re-run`)
    }

    mkdirSync(dir, { recursive: true })
    git(["init", "--quiet", dir])
    result = "cloned"
  }

  // Fetch the manifest URL directly (no named remote) so URL changes always take
  // effect. Shallow; with sparse patterns, blobs outside them are never downloaded.
  const filter = entry.sparse ? ["--filter=blob:none"] : []
  const what = target.kind === "sha" ? target.sha : `+refs/tags/${target.tag}:refs/tags/${target.tag}`
  git(["-C", dir, "fetch", "--quiet", "--no-tags", "--depth", "1", ...filter, entry.url, what])

  if (entry.sparse) {
    git(["-C", dir, "sparse-checkout", "set", "--no-cone", ...entry.sparse])
  } else if (existsSync(resolve(dir, ".git", "info", "sparse-checkout"))) {
    git(["-C", dir, "sparse-checkout", "disable"])
  }

  // Forced, detached checkout: reference clones are read-only, so stray local edits
  // are discarded rather than blocking the pin.
  const commit = target.kind === "sha" ? target.sha : `refs/tags/${target.tag}^{commit}`
  git(["-C", dir, "checkout", "--quiet", "--force", "--detach", commit])
  git(["-C", dir, "config", "--local", FINGERPRINT_KEY, expected])

  return result
}

export const runSyncReference = (argv: ReadonlyArray<string>): number => {
  const force = argv.includes("--force")

  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name)

    return index === -1 ? undefined : argv[index + 1]
  }

  const rootFlag = flag("--root")
  const manifestFlag = flag("--manifest")
  const root = rootFlag === undefined ? fileURLToPath(new URL("..", import.meta.url)) : resolve(rootFlag)

  const manifestPath = manifestFlag === undefined
    ? fileURLToPath(new URL("./reference.json", import.meta.url))
    : resolve(manifestFlag)

  if (!force && process.env["CI"]) {
    console.error("sync-reference: skipping in CI (reference clones are not build inputs); use --force to override")

    return 0
  }

  try {
    const manifest = loadManifest(manifestPath)
    const catalog = loadCatalog(resolve(root, "package.json"))

    for (const [prefix, entry] of Object.entries(manifest)) {
      const result = syncEntry(root, prefix, entry, catalog)
      console.error(`sync-reference: ${prefix} ${result} @ ${describeTarget(resolveTarget(entry, catalog))}`)
    }

    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (force) {
      console.error(`sync-reference: FAILED: ${message}`)

      return 1
    }

    console.error(
      `sync-reference: WARNING: could not sync reference clones (${message}). `
        + "Install continues; run `bun run reference:sync` to retry."
    )

    return 0
  }
}

if (import.meta.main) {
  process.exit(runSyncReference(process.argv.slice(2)))
}
