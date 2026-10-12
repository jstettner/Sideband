import { describe, expect, it } from "@effect/vitest"
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
