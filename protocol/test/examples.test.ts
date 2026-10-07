import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { readdir } from "node:fs/promises"
import {
  AgentOffline,
  type ErrorCode,
  ErrorResponse,
  IdempotencyConflict,
  Runner,
  SessionBusy,
  SessionState,
  Status,
  TextTurnBody,
  TurnCompleted,
  TurnFailed,
  TurnNeedsApproval,
  TurnRunning,
  TurnState,
  TurnUnknown
} from "../src/index.ts"

const examplesDir = new URL("../examples/", import.meta.url)

/** Every file in examples/ and the schema it must satisfy. */
const examples: Record<string, Schema.Codec<unknown, unknown>> = {
  "http/turn-request-text.json": TextTurnBody,
  "http/turn-completed.json": TurnCompleted,
  "http/turn-running.json": TurnRunning,
  "http/turn-needs-approval.json": TurnNeedsApproval,
  "http/turn-failed.json": TurnFailed,
  "http/turn-unknown.json": TurnUnknown,
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
  "runner/session-op.json": Runner.SessionOp,
  "runner/session-op-result.json": Runner.SessionOpResult,
  "runner/session-op-failed.json": Runner.SessionOpFailed
}

const readExample = (name: string): Promise<unknown> => Bun.file(new URL(name, examplesDir)).json()

describe("examples", () => {
  test("every example file has a schema", async () => {
    const files = await readdir(examplesDir, { recursive: true })
    expect(files.filter((file) => file.endsWith(".json")).sort()).toEqual(Object.keys(examples).sort())
  })

  for (const [name, schema] of Object.entries(examples)) {
    test(`${name} decodes and re-encodes unchanged`, async () => {
      const json = await readExample(name)
      const decoded = Schema.decodeUnknownSync(schema)(json)
      expect(Schema.encodeSync(schema)(decoded)).toEqual(json)
    })
  }

  test("turn outcomes decode as TurnState", async () => {
    const outcomes = Object.keys(examples).filter((name) =>
      name.startsWith("http/turn-") && name !== "http/turn-request-text.json"
    )
    for (const name of outcomes) {
      Schema.decodeUnknownSync(TurnState)(await readExample(name))
    }
  })

  test("errors decode as ErrorResponse", async () => {
    for (const name of Object.keys(examples).filter((name) => name.startsWith("http/error-"))) {
      const json = await readExample(name)
      expect(Schema.decodeUnknownSync(ErrorResponse)(json).error).toBe((json as { error: ErrorCode }).error)
    }
  })

  test("runner messages decode as RunnerMessage / RelayMessage", async () => {
    const relayToRunner = new Set(["runner/turn.json", "runner/session-op.json"])
    for (const name of Object.keys(examples).filter((name) => name.startsWith("runner/"))) {
      const schema = relayToRunner.has(name) ? Runner.RelayMessage : Runner.RunnerMessage
      Schema.decodeUnknownSync(schema)(await readExample(name))
    }
  })
})

describe("schemas", () => {
  test("idempotency key and session name are validated", () => {
    const turn = { type: "turn", key: "too-short", session: "main", transcript: "hi" }
    expect(() => Schema.decodeUnknownSync(Runner.Turn)(turn)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Runner.Turn)({ ...turn, key: "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f", session: "Main" })
    ).toThrow()
  })

  test("unknown fields are ignored", () => {
    const decoded = Schema.decodeUnknownSync(Runner.Ack)({
      type: "ack",
      key: "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f",
      added_later: true
    })
    expect(decoded).toEqual({ type: "ack", key: "4f9c2d7e-8b1a-4c3e-9f2d-6a5b8c7d9e0f" })
  })
})
