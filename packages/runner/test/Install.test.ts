import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import * as Install from "../src/Install/Install.ts"
import { Launchd } from "../src/Launchd/Launchd.ts"

const SETTINGS = "SIDEBAND_BACKEND_URL=https://sideband.example.workers.dev\nSIDEBAND_RUNNER_TOKEN=token\n"

/** launchd as a list of the calls made to it, with the job loaded or not. */
const fakeLaunchd = (loaded: boolean, onBootout: Effect.Effect<void> = Effect.void) => {
  const calls: Array<string> = []
  let isLoaded = loaded

  const layer = Layer.succeed(Launchd)({
    isLoaded: Effect.fnUntraced(function*(label: string) {
      yield* Effect.sync(() => calls.push(`isLoaded ${label}`))

      return isLoaded
    }),
    bootstrap: Effect.fnUntraced(function*(plist: string) {
      yield* Effect.sync(() => calls.push(`bootstrap ${plist}`))
      isLoaded = true
    }),
    bootout: Effect.fnUntraced(function*(label: string) {
      yield* onBootout
      calls.push(`bootout ${label}`)
      isLoaded = false
    }),
    kickstart: Effect.fnUntraced(function*(label: string) {
      yield* Effect.sync(() => calls.push(`kickstart ${label}`))
    }),
    job: Effect.fnUntraced(function*() {
      return yield* Effect.succeedNone
    })
  })

  return { calls, layer }
}

/** A fresh home directory, this runner's binary in it, and a seed settings file with `settings`. */
const setup = Effect.fnUntraced(function*(settings: string = SETTINGS) {
  const fs = yield* FileSystem.FileSystem
  const home = yield* fs.makeTempDirectoryScoped()
  const executable = `${home}/build/sideband-runner`
  const seed = `${home}/repo/.env`
  yield* fs.makeDirectory(`${home}/build`)
  yield* fs.writeFileString(executable, "new binary")
  yield* fs.makeDirectory(`${home}/repo`)
  yield* fs.writeFileString(seed, settings)

  const host: Install.Host = { home, platform: "darwin", executable, compiled: true }

  return { fs, home, host, seed, at: Install.paths(home) }
})

const exists = (fs: FileSystem.FileSystem, files: ReadonlyArray<string>) => Effect.forEach(files, (f) => fs.exists(f))

describe("install", () => {
  it.effect("copies the seed settings, readable only by their owner, then the binary, then loads the plist", () =>
    Effect.gen(function*() {
      const { fs, host, seed, at } = yield* setup()
      const launchd = fakeLaunchd(false)
      yield* Install.install(host, seed).pipe(Effect.provide(launchd.layer))

      expect(yield* fs.readFileString(at.config)).toBe(SETTINGS)
      expect((yield* fs.stat(at.config)).mode & 0o777).toBe(0o600)
      expect(yield* fs.readFileString(at.binary)).toBe("new binary")
      expect(yield* fs.readFileString(at.plist)).toContain(`<string>${at.binary}</string>`)
      expect(yield* fs.readFileString(at.plist)).toContain(`<string>${at.config}</string>`)
      expect(launchd.calls).toEqual([`isLoaded ${Install.LABEL}`, `bootstrap ${at.plist}`])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps settings that already exist", () =>
    Effect.gen(function*() {
      const { fs, host, seed, at } = yield* setup()
      const kept = `${SETTINGS}SIDEBAND_AGENT=echo\n`
      yield* fs.makeDirectory(`${host.home}/.config/sideband`, { recursive: true })
      yield* fs.writeFileString(at.config, kept)
      yield* Install.install(host, seed).pipe(Effect.provide(fakeLaunchd(false).layer))

      expect(yield* fs.readFileString(at.config)).toBe(kept)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reinstalling unloads the running job before its binary is replaced, then loads it again", () =>
    Effect.gen(function*() {
      const { fs, host, seed, at } = yield* setup()
      yield* fs.makeDirectory(`${host.home}/.local/bin`, { recursive: true })
      yield* fs.writeFileString(at.binary, "old binary")
      const seen: Array<string> = []

      const launchd = fakeLaunchd(
        true,
        Effect.orDie(fs.readFileString(at.binary)).pipe(Effect.map((b) => seen.push(b)))
      )

      yield* Install.install(host, seed).pipe(Effect.provide(launchd.layer))

      expect(seen).toEqual(["old binary"])
      expect(launchd.calls).toEqual([
        `isLoaded ${Install.LABEL}`,
        `bootout ${Install.LABEL}`,
        `bootstrap ${at.plist}`
      ])
      expect(yield* fs.readFileString(at.binary)).toBe("new binary")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  for (
    const [name, settings] of [
      ["settings without the runner token", "SIDEBAND_BACKEND_URL=https://sideband.example.workers.dev\n"],
      ["settings that select Hermes without its API key", `${SETTINGS}SIDEBAND_AGENT=hermes\n`]
    ]
  ) {
    it.effect(`${name} fail install before the binary, the plist, or launchd are touched`, () =>
      Effect.gen(function*() {
        const { fs, host, seed, at } = yield* setup(settings)
        const launchd = fakeLaunchd(true)
        const error = yield* Install.install(host, seed).pipe(Effect.provide(launchd.layer), Effect.flip)

        expect(error._tag).toBe("InstallError")
        expect(error.message).toContain(at.config)
        expect(yield* exists(fs, [at.binary, at.plist])).toEqual([false, false])
        expect(launchd.calls).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  }

  it.effect("refuses anywhere but macOS, and when not run from the built binary, touching nothing", () =>
    Effect.gen(function*() {
      const { fs, host, seed, at } = yield* setup()
      const launchd = fakeLaunchd(false)

      for (const other of [{ ...host, platform: "linux" }, { ...host, compiled: false }]) {
        yield* Install.install(other, seed).pipe(Effect.provide(launchd.layer), Effect.flip)
      }

      expect(yield* exists(fs, [at.config, at.binary, at.plist])).toEqual([false, false, false])
      expect(launchd.calls).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("uninstall", () => {
  const installed = Effect.gen(function*() {
    const setupResult = yield* setup()
    yield* Install.install(setupResult.host, setupResult.seed).pipe(Effect.provide(fakeLaunchd(false).layer))
    yield* setupResult.fs.writeFileString(setupResult.at.log, "log")

    return setupResult
  })

  it.effect("unloads the job and removes the plist and binary, keeping the settings and log", () =>
    Effect.gen(function*() {
      const { fs, host, at } = yield* installed
      const launchd = fakeLaunchd(true)
      yield* Install.uninstall(host, false).pipe(Effect.provide(launchd.layer))

      expect(launchd.calls).toEqual([`isLoaded ${Install.LABEL}`, `bootout ${Install.LABEL}`])
      expect(yield* exists(fs, [at.plist, at.binary, at.config, at.log])).toEqual([false, false, true, true])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("with purge, also removes the settings and log", () =>
    Effect.gen(function*() {
      const { fs, host, at } = yield* installed
      yield* Install.uninstall(host, true).pipe(Effect.provide(fakeLaunchd(false).layer))

      expect(yield* exists(fs, [at.plist, at.binary, at.config, at.log])).toEqual([false, false, false, false])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
