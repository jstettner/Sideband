import { describe, expect, it } from "@effect/vitest"
import * as Plist from "../src/Launchd/Plist.ts"

const agent: Plist.Agent = {
  label: "com.sideband.runner",
  program: ["/Users/me/.local/bin/sideband-runner", "run", "--config", "/Users/me/.config/sideband/runner.env"],
  log: "/Users/me/Library/Logs/sideband/runner.log"
}

/** The XML between `<key>name</key>` and the next key, trimmed. */
const value = (plist: string, name: string) =>
  plist.split(`<key>${name}</key>`)[1]?.split("<key>")[0]?.replaceAll(/\s+/g, " ").trim()

describe("Plist.render", () => {
  it("keeps the runner down after a clean exit and restarts it after any other (SuccessfulExit stays false)", () => {
    const plist = Plist.render(agent)

    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/u)
  })

  it("starts the runner at login with its arguments, logging both streams to the log", () => {
    const plist = Plist.render(agent)

    expect(value(plist, "Label")).toBe("<string>com.sideband.runner</string>")
    expect(value(plist, "RunAtLoad")).toBe("<true/>")
    expect(value(plist, "ProgramArguments")).toBe(
      `<array> ${agent.program.map((argument) => `<string>${argument}</string>`).join(" ")} </array>`
    )
    expect(value(plist, "StandardOutPath")).toBe(`<string>${agent.log}</string>`)
    expect(value(plist, "StandardErrorPath")?.startsWith(`<string>${agent.log}</string>`)).toBe(true)
  })

  it("escapes paths as XML", () => {
    const plist = Plist.render({ ...agent, program: ["/Users/a&b/<runner> \"x\""] })

    expect(plist).toContain("<string>/Users/a&amp;b/&lt;runner&gt; &quot;x&quot;</string>")
  })
})
