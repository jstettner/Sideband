/**
 * The launchd agent's property list. Pure, so what launchd is told to do is tested without launchd.
 */

export interface Agent {
  /** The job label, which `launchctl` addresses it by. */
  readonly label: string
  /** The runner binary and its arguments. */
  readonly program: ReadonlyArray<string>
  /** Where launchd writes the runner's stdout and stderr. */
  readonly log: string
}

const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const string = (text: string): string => `<string>${escape(text)}</string>`

/**
 * The agent starts at login and is restarted after it crashes, but not after it exits cleanly: the runner exits 0
 * only when another runner replaced it (close code 4000), and that one should keep the connection.
 */
export const render = (agent: Agent): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${string(agent.label)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...agent.program.map((argument) => `    ${string(argument)}`),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  ${string(agent.log)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${string(agent.log)}`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n")
