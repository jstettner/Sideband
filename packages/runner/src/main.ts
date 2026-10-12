import { BunRuntime, BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Layer } from "effect"
import { Command, Flag } from "effect/cli"
import { homedir } from "node:os"
import pkg from "../package.json" with { type: "json" }
import * as Config from "./Config.ts"
import * as Connection from "./Connection/Connection.ts"
import * as Install from "./Install/Install.ts"
import * as Launchd from "./Launchd/Launchd.ts"
import * as Layers from "./Layers.ts"

const host: Install.Host = {
  home: homedir(),
  platform: process.platform,
  executable: process.execPath,
  // A built binary's modules live in Bun's embedded file system.
  compiled: import.meta.url.startsWith("file:///$bunfs/")
}

const installed = Install.paths(host.home)

/**
 * Keeps the connection to the relay until another runner replaces this one (exit 0) or the relay rejects
 * its protocol (exit 1). launchd restarts it after any other exit.
 */
const run = Effect.fnUntraced(function*(config: string) {
  const settings = yield* Config.provider(config)

  return yield* Connection.run.pipe(
    Effect.provide(Layers.Main),
    Effect.provideService(ConfigProvider.ConfigProvider, settings)
  )
})

const runCommand = Command.make(
  "run",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription("Settings file, read after the environment"),
      Flag.withDefault(installed.config)
    )
  },
  ({ config }) => run(config)
).pipe(Command.withDescription("Connect to the relay and run turns (the default)"))

const install = Command.make(
  "install",
  {
    seed: Flag.String("seed").pipe(
      Flag.withDescription(`Settings to copy to ${installed.config} if it doesn't exist yet`),
      Flag.withDefault(".env")
    )
  },
  ({ seed }) => Install.install(host, seed)
).pipe(Command.withDescription("Install (or reinstall) the launchd agent and start it"))

const uninstall = Command.make(
  "uninstall",
  {
    purge: Flag.Boolean("purge").pipe(
      Flag.withDescription("Also delete the settings and the log"),
      Flag.withDefault(false)
    )
  },
  ({ purge }) => Install.uninstall(host, purge)
).pipe(Command.withDescription("Stop and remove the launchd agent"))

const restart = Command.make("restart", {}, () => Install.restart()).pipe(
  Command.withDescription("Restart the launchd agent")
)

const status = Command.make("status", {}, () => Install.status(host, pkg.version)).pipe(
  Command.withDescription("Whether the agent is loaded and running, and the installed version")
)

const logs = Command.make(
  "logs",
  {
    follow: Flag.Boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Keep printing as the log grows"),
      Flag.withDefault(false)
    )
  },
  ({ follow }) => Install.logs(host, follow)
).pipe(Command.withDescription(`Print the agent's log (${installed.log})`))

Command.make("sideband-runner", {}, () => run(installed.config)).pipe(
  Command.withDescription(
    "The Sideband runner: keeps a WebSocket to a backend's relay and runs turns against the agent"
  ),
  Command.withSubcommands([runCommand, install, uninstall, restart, status, logs]),
  Command.run({ version: pkg.version }),
  // `getuid` is missing only on Windows, which has no launchd: `install` refuses to run there.
  Effect.provide(Launchd.layer(process.getuid?.() ?? -1).pipe(Layer.provideMerge(BunServices.layer))),
  BunRuntime.runMain
)
