import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import * as Launchd from "../src/Launchd/Launchd.ts"

/** Trimmed from `launchctl print gui/501/com.sideband.runner`. */
const running = `gui/501/com.sideband.runner = {
	active count = 1
	path = /Users/me/Library/LaunchAgents/com.sideband.runner.plist
	type = LaunchAgent
	state = running

	program = /Users/me/.local/bin/sideband-runner
	arguments = {
		/Users/me/.local/bin/sideband-runner
		run
	}

	runs = 3
	pid = 4242
	immediate reason = speculative
	forks = 0
	execs = 1
	last exit code = 1
}`

describe("parsePrint", () => {
  it("reads the pid and the last exit code", () => {
    expect(Launchd.parsePrint(running)).toEqual({ pid: 4242, lastExitCode: "1" })
  })

  it("a job that isn't running has no pid; one that never exited says so", () => {
    const idle = running.replace(/^\s*pid = .*$/mu, "").replace("last exit code = 1", "last exit code = (never exited)")

    expect(Launchd.parsePrint(idle)).toEqual({ lastExitCode: "(never exited)" })
  })
})

/**
 * `launchctl` as a script: `print` finds the job until `printsAfterBootout` more prints have passed since
 * `bootout`, as launchd does while it tears a job down. Records every call.
 */
const launchctl = (printsAfterBootout: number) => {
  const calls: Array<string> = []
  let bootedOut = false
  let prints = 0

  const answer = (args: ReadonlyArray<string>): number => {
    if (args[0] === "bootout") {
      bootedOut = true

      return 0
    }

    if (args[0] !== "print") return 0

    if (!bootedOut) return 0

    prints++

    return prints <= printsAfterBootout ? 0 : 113
  }

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : []
      calls.push(args.join(" "))
      const code = answer(args)

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.make(new TextEncoder().encode(code === 0 ? running : "Could not find service"))
      })
    })
  )

  return {
    calls,
    layer: Launchd.layer(501).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)))
  }
}

describe("bootout", () => {
  it.effect("returns only once launchd no longer has the job, so a bootstrap right after it can't fail", () =>
    Effect.gen(function*() {
      const script = launchctl(3)

      const done = yield* Launchd.Launchd.use((launchd) => launchd.bootout("com.sideband.runner")).pipe(
        Effect.provide(script.layer),
        Effect.forkChild
      )

      yield* TestClock.adjust("1 second")
      yield* Fiber.join(done)

      expect(script.calls.filter((call) => call.startsWith("print"))).toHaveLength(4)
    }))

  it.effect("fails if the job never goes away", () =>
    Effect.gen(function*() {
      const script = launchctl(Number.POSITIVE_INFINITY)

      const failed = yield* Launchd.Launchd.use((launchd) => launchd.bootout("com.sideband.runner")).pipe(
        Effect.provide(script.layer),
        Effect.flip,
        Effect.forkChild
      )

      yield* TestClock.adjust("1 minute")

      expect((yield* Fiber.join(failed))._tag).toBe("LaunchdError")
    }))
})
