// Checks that each `packages/backend-cloudflare/src` file's name says which Cloudflare kind it declares: a
// Worker lives in `<Name>Worker.ts` and a Durable Object in `<Name>DO.ts`. Each file declares at most one
// kind, and a file whose name carries a kind's suffix declares that kind.
//
// Runs as part of `bun run lint`. `src/scripts/` is skipped: its files are entry points, not modules.

import { readdirSync, readFileSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"

/** A kind of declaration, how to spot it in source, and the file name it requires. */
export interface Kind {
  readonly name: string
  readonly declares: RegExp
  /** The PascalCase suffix of the file's base name. */
  readonly suffix: string
}

export const kinds: ReadonlyArray<Kind> = [
  // A Worker or Durable Object is declared as a class (`class X extends Cloudflare.Worker<X>()("X")`); the
  // same generic elsewhere is a type, such as a binding's namespace (`Cloudflare.DurableObject<XDO>`).
  { name: "Worker", declares: /\bextends\s+Cloudflare\.Worker</, suffix: "Worker" },
  { name: "Durable Object", declares: /\bextends\s+Cloudflare\.DurableObject</, suffix: "DO" }
]

/** `source` without comments, so prose that names an API doesn't count as declaring it. */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const hasName = (kind: Kind, path: string): boolean => basename(path, ".ts").endsWith(kind.suffix)

/** What's wrong with the name of the file at `path` (relative to `src/`) given its `source`. */
export const violations = (path: string, source: string): ReadonlyArray<string> => {
  const code = stripComments(source)
  const declared = kinds.filter((kind) => kind.declares.test(code))
  const problems: Array<string> = []

  if (declared.length > 1) {
    problems.push(`${path} declares ${declared.map((kind) => kind.name).join(" and ")}: one kind per file`)
  }

  for (const kind of declared) {
    if (!hasName(kind, path)) problems.push(`${path} declares a ${kind.name}, so it must be named ${kind.suffix}.ts`)
  }

  for (const kind of kinds) {
    if (!declared.includes(kind) && hasName(kind, path)) {
      problems.push(`${path} is named like a ${kind.name} (${kind.suffix}.ts) but doesn't declare one`)
    }
  }

  return problems
}

const sourceFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)

    if (entry.isDirectory()) return entry.name === "scripts" ? [] : sourceFiles(path)

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : []
  })

/** Every violation under `srcDir`. */
export const check = (srcDir: string): ReadonlyArray<string> =>
  sourceFiles(srcDir).flatMap((path) =>
    violations(relative(srcDir, path).split(sep).join("/"), readFileSync(path, "utf8"))
  )

if (import.meta.main) {
  const problems = check(join(import.meta.dirname, "..", "packages", "backend-cloudflare", "src"))

  for (const problem of problems) console.error(problem)

  if (problems.length > 0) {
    process.exit(1)
  }
}
