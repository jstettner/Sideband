import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import {
  AgentOffline,
  ErrorResponse,
  IdempotencyConflict,
  Runner,
  SessionBusy,
  SessionState,
  Status,
  TextTurnBody,
  TurnCompleted,
  TurnFailed,
  TurnMerged,
  TurnNeedsApproval,
  TurnRunning,
  TurnState,
  TurnUnknown
} from "../src/index.ts"

const examplesDir = new URL("../examples/", import.meta.url)

/** Every file in examples/ and the schema it must satisfy. */
const examples = {
  "http/turn-request-text.json": TextTurnBody,
  "http/turn-completed.json": TurnCompleted,
  "http/turn-running.json": TurnRunning,
  "http/turn-needs-approval.json": TurnNeedsApproval,
  "http/turn-failed.json": TurnFailed,
  "http/turn-unknown.json": TurnUnknown,
  "http/turn-merged.json": TurnMerged,
  "http/error-agent-offline.json": AgentOffline,
  "http/error-session-busy.json": SessionBusy,
  "http/error-idempotency-conflict.json": IdempotencyConflict,
  "http/status.json": Status,
  "http/session-state.json": SessionState,
  "runner/hello.json": Runner.Hello,
  "runner/turn.json": Runner.Turn,
  "runner/ack.json": Runner.Ack,
  "runner/result.json": Runner.TurnResult,
  "runner/needs-approval.json": Runner.TurnNeedsApproval,
  "runner/turn-failed.json": Runner.TurnFailed,
  "runner/steer.json": Runner.Steer,
  "runner/merged.json": Runner.TurnMerged,
  "runner/session-op.json": Runner.SessionOp,
  "runner/session-op-result.json": Runner.SessionOpResult,
  "runner/session-op-failed.json": Runner.SessionOpFailed
} satisfies Record<string, Schema.Codec<unknown, unknown>>

const readExample = (name: string): Schema.Json => JSON.parse(readFileSync(new URL(name, examplesDir), "utf8"))

describe("examples", () => {
  it("every example file has a schema", () => {
    const files = readdirSync(examplesDir, { recursive: true, encoding: "utf8" })
    expect(files.filter((file) => file.endsWith(".json")).toSorted()).toEqual(Object.keys(examples).toSorted())
  })

  for (const [name, schema] of Object.entries(examples)) {
    it.effect(`${name} decodes and re-encodes unchanged`, () =>
      Effect.gen(function*() {
        const json = readExample(name)
        const decoded = yield* Schema.decodeUnknownEffect(schema)(json)
        expect(yield* Schema.encodeEffect(schema)(decoded)).toEqual(json)
      }))
  }

  it("turn outcomes decode as TurnState", () => {
    const outcomes = Object.keys(examples).filter((name) =>
      name.startsWith("http/turn-") && name !== "http/turn-request-text.json"
    )

    for (const name of outcomes) {
      Schema.decodeUnknownSync(TurnState)(readExample(name))
    }
  })

  it("errors decode as ErrorResponse", () => {
    for (const name of Object.keys(examples).filter((file) => file.startsWith("http/error-"))) {
      const json = readExample(name)
      expect(Schema.encodeSync(ErrorResponse)(Schema.decodeUnknownSync(ErrorResponse)(json))).toEqual(json)
    }
  })

  it("runner messages decode as RunnerMessage / RelayMessage", () => {
    const relayToRunner = new Set(["runner/turn.json", "runner/steer.json", "runner/session-op.json"])

    for (const name of Object.keys(examples).filter((file) => file.startsWith("runner/"))) {
      const schema = relayToRunner.has(name) ? Runner.RelayMessage : Runner.RunnerMessage
      Schema.decodeUnknownSync(schema)(readExample(name))
    }
  })
})

describe("schemas", () => {
  it("idempotency key and session name are validated", () => {
    const turn = { type: "turn", key: "too-short", session: "main", transcript: "hi" }
    expect(() => Schema.decodeUnknownSync(Runner.Turn)(turn)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Runner.Turn)({ ...turn, key: "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f", session: "Main" })
    ).toThrow()
  })

  it("hello accepts protocol 1 and 2, nothing else", () => {
    const hello = { type: "hello", runner_version: "0.1.0", agent: { name: "Hermes" }, in_flight: [] }
    expect(Schema.decodeUnknownSync(Runner.Hello)({ ...hello, protocol: 1 }).protocol).toBe(1)
    expect(Schema.decodeUnknownSync(Runner.Hello)({ ...hello, protocol: 2 }).protocol).toBe(2)
    expect(() => Schema.decodeUnknownSync(Runner.Hello)({ ...hello, protocol: 3 })).toThrow()
  })

  it("unknown fields are ignored", () => {
    const decoded = Schema.decodeUnknownSync(Runner.Ack)({
      type: "ack",
      key: "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f",
      added_later: true
    })

    expect(decoded).toEqual({ type: "ack", key: "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f" })
  })
})
