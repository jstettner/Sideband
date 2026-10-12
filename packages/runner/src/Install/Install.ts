/**
 * Installs the runner as a launchd agent, and the commands that manage it once installed. Everything lives
 * at stable paths under the home directory, so moving or rebuilding the repo can't break the agent: the
 * binary is a copy, and the settings are a file of their own.
 */
import { Adapters } from "@sideband/agents"
import { ConfigProvider, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RunnerConfig } from "../Config.ts"
import { Launchd } from "../Launchd/Launchd.ts"
import * as Plist from "../Launchd/Plist.ts"

/** The launchd job label. The same as the hand-written plist used, so installing replaces that agent. */
export const LABEL = "com.sideband.runner"

/** Where an installed runner's files live. */
export interface Paths {
  readonly binary: string
  /** Settings, `KEY=value` lines; holds the runner token and the agent's key, so only its owner reads it. */
  readonly config: string
  /** Survives reboots, unlike `/tmp`, and shows in Console.app. */
  readonly log: string
  readonly plist: string
}

export const paths = (home: string): Paths => ({
  binary: `${home}/.local/bin/sideband-runner`,
  config: `${home}/.config/sideband/runner.env`,
  log: `${home}/Library/Logs/sideband/runner.log`,
  plist: `${home}/Library/LaunchAgents/${LABEL}.plist`
})

/** The machine the commands run on. */
export interface Host {
  readonly home: string
  /** `process.platform`. */
  readonly platform: string
  /** This runner's own binary, which `install` copies. */
  readonly executable: string
  /** Running as a built binary (`bun run build`), not as a script under `bun`, whose binary is Bun itself. */
  readonly compiled: boolean
}

export class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
  message: Schema.String
}) {}

/** Fails unless the runner and the agent adapter it selects can start with the settings in `config`. */
const validate = Effect.fnUntraced(function*(config: string) {
  const provider = yield* ConfigProvider.fromDotEnv({ path: config })

  yield* Effect.gen(function*() {
    yield* RunnerConfig
    yield* Layer.build(Adapters.layer.pipe(Layer.provide(FetchHttpClient.layer)))
  }).pipe(
    Effect.scoped,
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.mapError((error) => new InstallError({ message: `${config}: ${error.message}` }))
  )
})

/**
 * Installs (or reinstalls) the agent: seeds the settings from `seed` if there are none yet, checks them,
 * copies this binary, writes the plist, and (re)loads the job. Nothing is touched before the settings check
 * passes, so a broken configuration never becomes a crash loop.
 */
export const install = Effect.fn("Install.install")(function*(host: Host, seed: string) {
  if (host.platform !== "darwin") {
    return yield* new InstallError({ message: `the runner installs as a launchd agent, which needs macOS` })
  }

  if (!host.compiled) {
    return yield* new InstallError({
      message: "install copies the binary it runs from, so run it from the built runner: bun run runner:install"
    })
  }

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const launchd = yield* Launchd
  const at = paths(host.home)

  if (!(yield* fs.exists(at.config))) {
    if (!(yield* fs.exists(seed))) {
      return yield* new InstallError({
        message: `no settings at ${at.config}, and none to copy from ${path.resolve(seed)}`
      })
    }

    yield* fs.makeDirectory(path.dirname(at.config), { recursive: true })
    yield* fs.copyFile(seed, at.config)
    yield* fs.chmod(at.config, 0o600)
    yield* Console.log(`settings: copied ${path.resolve(seed)} to ${at.config}`)
  }

  yield* validate(at.config)

  // Stopped before its binary is replaced, so the running copy is never overwritten.
  if (yield* launchd.isLoaded(LABEL)) yield* launchd.bootout(LABEL)

  if (path.resolve(host.executable) !== at.binary) {
    yield* fs.makeDirectory(path.dirname(at.binary), { recursive: true })
    yield* fs.copyFile(host.executable, `${at.binary}.new`)
    yield* fs.chmod(`${at.binary}.new`, 0o755)
    yield* fs.rename(`${at.binary}.new`, at.binary)
  }

  yield* fs.makeDirectory(path.dirname(at.log), { recursive: true })
  yield* fs.makeDirectory(path.dirname(at.plist), { recursive: true })

  yield* fs.writeFileString(
    at.plist,
    Plist.render({ label: LABEL, program: [at.binary, "run", "--config", at.config], log: at.log })
  )

  yield* launchd.bootstrap(at.plist)
  yield* Console.log(`installed ${LABEL}: ${at.binary}, logging to ${at.log}`)
})

/** Unloads the agent and removes its plist and binary; `purge` also removes its settings and log. */
export const uninstall = Effect.fn("Install.uninstall")(function*(host: Host, purge: boolean) {
  const fs = yield* FileSystem.FileSystem
  const launchd = yield* Launchd
  const at = paths(host.home)

  if (yield* launchd.isLoaded(LABEL)) yield* launchd.bootout(LABEL)

  for (const file of purge ? [at.plist, at.binary, at.config, at.log] : [at.plist, at.binary]) {
    yield* fs.remove(file, { force: true })
  }

  yield* Console.log(`uninstalled ${LABEL}${purge ? ", with its settings and log" : ""}`)
})

/** Restarts the agent, killing the running runner first. */
export const restart = Effect.fn("Install.restart")(function*() {
  const launchd = yield* Launchd

  if (!(yield* launchd.isLoaded(LABEL))) return yield* new InstallError({ message: `${LABEL} isn't installed` })

  yield* launchd.kickstart(LABEL)
})

/** Whether the agent is loaded and running, how it last exited, and whether its binary is this version. */
export const status = Effect.fn("Install.status")(function*(host: Host, version: string) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const launchd = yield* Launchd
  const at = paths(host.home)
  const job = yield* launchd.job(LABEL)

  yield* Option.match(job, {
    onNone: () => Console.log(`${LABEL}: not loaded`),
    onSome: ({ pid, lastExitCode }) =>
      Console.log(
        `${LABEL}: loaded, ${pid === undefined ? "not running" : `running (pid ${pid})`}, ` +
          `last exit code ${lastExitCode ?? "unknown"}`
      )
  })

  if (!(yield* fs.exists(at.binary))) return yield* Console.log(`binary: none at ${at.binary}`)

  const installed = yield* spawner.string(ChildProcess.make(at.binary, ["--version"])).pipe(
    Effect.map((output) => output.trim()),
    Effect.orElseSucceed(() => "unknown")
  )

  yield* Console.log(`binary: ${at.binary}, ${installed} (this one is v${version})`)
})

/** Prints the end of the agent's log; `follow` keeps printing as it grows. */
export const logs = Effect.fn("Install.logs")(function*(host: Host, follow: boolean) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const at = paths(host.home)

  yield* spawner.exitCode(
    ChildProcess.make("tail", ["-n", "200", ...follow ? ["-f"] : [], at.log], {
      stdout: "inherit",
      stderr: "inherit"
    })
  )
})
