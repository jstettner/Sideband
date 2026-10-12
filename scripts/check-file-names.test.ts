import { describe, expect, it } from "@effect/vitest"
import { join } from "node:path"
import { check, violations } from "./check-file-names.ts"

const relay = "class RelayDO extends Cloudflare.DurableObject<RelayDO, {}>()(\"Relay\") {}"

const worker = "class SidebandWorker extends Cloudflare.Worker<SidebandWorker, {}>()(\"Sideband\") {}"

describe("violations", () => {
  it("accepts a Durable Object in a DO file, and a Worker in a Worker file", () => {
    expect(violations("Relay/RelayDO.ts", relay)).toEqual([])
    expect(violations("Sideband/SidebandWorker.ts", worker)).toEqual([])
  })

  it("rejects a Durable Object or Worker without its suffix", () => {
    expect(violations("Relay/Relay.ts", relay)).toEqual([
      "Relay/Relay.ts declares a Durable Object, so it must be named DO.ts"
    ])
    expect(violations("Sideband/Sideband.ts", worker)).toEqual([
      "Sideband/Sideband.ts declares a Worker, so it must be named Worker.ts"
    ])
  })

  it("rejects a file named for a kind it doesn't declare", () => {
    expect(violations("Relay/RelayDO.ts", "export const x = 1")).toEqual([
      "Relay/RelayDO.ts is named like a Durable Object (DO.ts) but doesn't declare one"
    ])
  })

  it("rejects two kinds in one file", () => {
    expect(violations("Sideband/SidebandWorker.ts", `${worker}\n${relay}`)).toEqual([
      "Sideband/SidebandWorker.ts declares Worker and Durable Object: one kind per file",
      "Sideband/SidebandWorker.ts declares a Durable Object, so it must be named DO.ts"
    ])
  })

  it("ignores APIs named only in comments, and types that aren't declarations", () => {
    expect(violations("Relay/Store.ts", "// class X extends Cloudflare.DurableObject<X>\n/* Cloudflare.Worker<X> */"))
      .toEqual([])
    expect(violations("Relay/RelayClient.ts", "const layer = (relays: Cloudflare.DurableObject<RelayDO>) => relays"))
      .toEqual([])
  })
})

describe("check", () => {
  it("passes on packages/backend-cloudflare/src", () => {
    expect(check(join(import.meta.dirname, "..", "packages", "backend-cloudflare", "src"))).toEqual([])
  })
})
