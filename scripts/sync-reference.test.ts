import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadManifest,
  type ReferenceEntry,
  resolveRefTemplate,
  resolveTarget,
  runSyncReference,
  syncEntry
} from "./sync-reference.ts"

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  }).trim()

const write = (path: string, content: string): void => {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

let tmp: string

let upstreamUrl: string

let firstSha: string

// A bare "upstream" with two tagged releases, served over file:// so shallow fetches behave as they
// do against GitHub. Tags: lib@1.0.0 (lightweight), lib@1.1.0 (annotated, like Alchemy's).
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sync-reference-"))
  const work = join(tmp, "work")
  mkdirSync(work)
  git(work, "init", "--quiet", "--initial-branch=main")
  write(join(work, "README.md"), "v1\n")
  write(join(work, "keep", "a.ts"), "export const a = 1\n")
  write(join(work, "drop", "b.ts"), "export const b = 1\n")
  git(work, "add", ".")
  git(work, "commit", "--quiet", "-m", "v1")
  git(work, "tag", "lib@1.0.0")
  firstSha = git(work, "rev-parse", "HEAD")
  write(join(work, "README.md"), "v2\n")
  git(work, "commit", "--quiet", "-am", "v2")
  git(work, "tag", "-a", "-m", "release", "lib@1.1.0")

  const bare = join(tmp, "upstream.git")
  git(tmp, "clone", "--quiet", "--bare", work, bare)
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(bare, "config", "uploadpack.allowFilter", "true")
  upstreamUrl = `file://${bare}`

  mkdirSync(join(tmp, "root"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const root = () => join(tmp, "root")

const readme = (prefix: string) => readFileSync(join(root(), prefix, "README.md"), "utf8")

describe("resolveRefTemplate", () => {
  it("fills {catalog:name} from the catalog", () => {
    expect(resolveRefTemplate("effect@{catalog:effect}", { effect: "4.0.2" })).toBe("effect@4.0.2")
    expect(resolveRefTemplate("v{catalog:alchemy}", { alchemy: "2.0.0-beta.81" })).toBe("v2.0.0-beta.81")
  })

  it("leaves templates without placeholders alone", () => {
    expect(resolveRefTemplate("v1.0.0", {})).toBe("v1.0.0")
  })

  it("rejects a name missing from the catalog", () => {
    expect(() => resolveRefTemplate("x@{catalog:missing}", { effect: "4.0.2" })).toThrow(/"missing"/)
  })

  it("resolves a sha entry to itself and a ref entry through the catalog", () => {
    expect(resolveTarget({ url: "u", sha: firstSha }, {})).toEqual({ kind: "sha", sha: firstSha })
    expect(resolveTarget({ url: "u", ref: "lib@{catalog:lib}" }, { lib: "1.0.0" })).toEqual({
      kind: "tag",
      tag: "lib@1.0.0"
    })
  })
})

const manifest = (value: Schema.Json) => {
  const path = join(tmp, "manifest.json")
  writeFileSync(path, JSON.stringify(value))

  return path
}

describe("loadManifest", () => {
  it("accepts sha and ref entries, with optional sparse patterns", () => {
    const loaded = loadManifest(manifest({
      "reference/a": { url: "https://example.com/a.git", sha: firstSha },
      "reference/b": { url: "https://example.com/b.git", ref: "v{catalog:b}", sparse: ["/*", "!/*/"] }
    }))

    expect(Object.keys(loaded)).toEqual(["reference/a", "reference/b"])
  })

  it("rejects a short sha", () => {
    expect(() => loadManifest(manifest({ "reference/a": { url: "u", sha: "ebb526d" } }))).toThrow()
  })

  it("rejects an entry with neither sha nor ref", () => {
    expect(() => loadManifest(manifest({ "reference/a": { url: "u" } }))).toThrow()
  })

  it("accepts the repo's own manifest", () => {
    expect(() => loadManifest(join(import.meta.dirname, "reference.json"))).not.toThrow()
  })
})

/** The upstream, pinned through the catalog: `lib@{catalog:lib}`. */
const entry = (): ReferenceEntry => ({ url: upstreamUrl, ref: "lib@{catalog:lib}" })

describe("syncEntry", () => {
  it("clones at the catalog-resolved tag, so `git describe --tags` names it", () => {
    expect(syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })).toBe("cloned")
    expect(readme("reference/lib")).toBe("v1\n")
    expect(git(join(root(), "reference/lib"), "describe", "--tags")).toBe("lib@1.0.0")
  })

  it("reports up-to-date without touching the network", () => {
    syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })
    rmSync(join(tmp, "upstream.git"), { recursive: true, force: true })
    expect(syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })).toBe("up-to-date")
  })

  it("moves with the catalog: a bumped pin updates the clone (annotated tags too)", () => {
    syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })
    expect(syncEntry(root(), "reference/lib", entry(), { lib: "1.1.0" })).toBe("updated")
    expect(readme("reference/lib")).toBe("v2\n")
    expect(git(join(root(), "reference/lib"), "describe", "--tags")).toBe("lib@1.1.0")
  })

  it("discards local edits when it re-syncs", () => {
    syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })
    writeFileSync(join(root(), "reference/lib/README.md"), "edited\n")
    syncEntry(root(), "reference/lib", entry(), { lib: "1.1.0" })
    expect(readme("reference/lib")).toBe("v2\n")
  })

  it("checks out an exact sha", () => {
    const shaEntry: ReferenceEntry = { url: upstreamUrl, sha: firstSha }
    expect(syncEntry(root(), "reference/pinned", shaEntry, {})).toBe("cloned")
    expect(git(join(root(), "reference/pinned"), "rev-parse", "HEAD")).toBe(firstSha)
    expect(syncEntry(root(), "reference/pinned", shaEntry, {})).toBe("up-to-date")
  })

  it("applies non-cone sparse patterns, and re-syncs when they change", () => {
    const sparse: ReferenceEntry = { ...entry(), sparse: ["/*", "!/*/", "/keep/"] }
    syncEntry(root(), "reference/lib", sparse, { lib: "1.0.0" })
    const dir = join(root(), "reference/lib")
    expect(existsSync(join(dir, "README.md"))).toBe(true)
    expect(existsSync(join(dir, "keep/a.ts"))).toBe(true)
    expect(existsSync(join(dir, "drop"))).toBe(false)

    expect(syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })).toBe("updated")
    expect(existsSync(join(dir, "drop/b.ts"))).toBe(true)
  })

  it("refuses to overwrite a non-empty directory that isn't a clone", () => {
    write(join(root(), "reference/lib/mine.txt"), "mine\n")
    expect(() => syncEntry(root(), "reference/lib", entry(), { lib: "1.0.0" })).toThrow(/not a git clone/)
  })
})

/** A root package.json with a catalog, plus a one-entry manifest; returns the CLI args for them. */
const setupRoot = (url: string) => {
  writeFileSync(
    join(root(), "package.json"),
    JSON.stringify({ workspaces: { packages: [], catalog: { lib: "1.0.0" } } })
  )
  const manifestPath = join(tmp, "reference.json")
  writeFileSync(manifestPath, JSON.stringify({ "reference/lib": { url, ref: "lib@{catalog:lib}" } }))

  return ["--root", root(), "--manifest", manifestPath]
}

const withCI = <A>(value: string | undefined, f: () => A): A => {
  const previous = process.env["CI"]

  if (value === undefined) delete process.env["CI"]
  else process.env["CI"] = value

  try {
    return f()
  } finally {
    if (previous === undefined) delete process.env["CI"]
    else process.env["CI"] = previous
  }
}

describe("runSyncReference", () => {
  it("syncs every entry from the manifest, reading the catalog from <root>/package.json", () => {
    const args = setupRoot(upstreamUrl)
    expect(withCI(undefined, () => runSyncReference(args))).toBe(0)
    expect(readme("reference/lib")).toBe("v1\n")
  })

  it("warns and exits 0 when the sync fails (offline install), but fails under --force", () => {
    const args = setupRoot(`file://${join(tmp, "does-not-exist.git")}`)
    expect(withCI(undefined, () => runSyncReference(args))).toBe(0)
    expect(withCI(undefined, () => runSyncReference([...args, "--force"]))).toBe(1)
  })

  it("is skipped under CI unless forced", () => {
    const args = setupRoot(upstreamUrl)
    expect(withCI("true", () => runSyncReference(args))).toBe(0)
    expect(existsSync(join(root(), "reference/lib"))).toBe(false)
    expect(withCI("true", () => runSyncReference([...args, "--force"]))).toBe(0)
    expect(readme("reference/lib")).toBe("v1\n")
  })
})
