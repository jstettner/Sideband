/**
 * The Relay's SQL on a real SQLite (`node:sqlite`): the migrations and the store's reads and writes. Durable
 * Object storage is SQLite too; what only the object can show (transactions over its storage, hibernation)
 * is in `workers.test.ts`.
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Lifecycle from "../src/Relay/Lifecycle.ts"
import * as Migrations from "../src/Relay/Migrations.ts"
import * as Store from "../src/Relay/Store.ts"
import { agentSession, key, millis, result, SESSION } from "./Harness.ts"

const database = () => Layer.fresh(SqliteClient.layer({ filename: ":memory:" }))

const row = (name: string, fields: Partial<Lifecycle.OpenTurnRow> = {}): Lifecycle.OpenTurnRow => ({
  key: key(name),
  session: SESSION,
  payload_hash: `hash-${name}`,
  transcript: `say ${name}`,
  transcript_raw: null,
  state: "sent",
  outcome: null,
  steer_into: null,
  created_at: millis(1000),
  updated_at: millis(1000),
  ...fields
})

const done = (name: string, fields: Partial<Lifecycle.OpenTurnRow> = {}): Lifecycle.TurnRow => ({
  ...row(name, fields),
  state: "done",
  outcome: result(name)
})

describe("Migrations", () => {
  it.effect("migrate to the newest bundled migration, and running them again applies nothing", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      expect(yield* Migrations.latestApplied).toBe(Migrations.latest)
      expect(yield* Migrations.run).toEqual([])
    }).pipe(Effect.provide(database())))

  it.effect("only a done turn can have an outcome", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* Migrations.run

      const insert = (state: string, outcome: string | null) =>
        sql`
          INSERT INTO turns (key, session, payload_hash, transcript, state, outcome_json, created_at, updated_at)
          VALUES (${`${state}-${String(outcome)}`}, 'main', 'hash', 'say', ${state}, ${outcome}, 1, 1)
        `.pipe(Effect.exit)

      const outcomes = [
        yield* insert("done", null),
        yield* insert("sent", "{}"),
        yield* insert("pending", null),
        yield* insert("done", "{}"),
        yield* insert("acked", null)
      ]

      expect(outcomes.map((exit) => exit._tag)).toEqual(["Failure", "Failure", "Failure", "Success", "Success"])
    }).pipe(Effect.provide(database())))
})

describe("Store", () => {
  it.effect("saved rows read back as they were written, outcome and context included", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const answered = done("a", { transcript_raw: "say a." })

      const session: Lifecycle.SessionRow = {
        name: SESSION,
        agent_session_id: agentSession("s1"),
        active_key: key("b"),
        context: { used_tokens: 5, limit_tokens: 9 },
        last_activity: millis(1000)
      }

      yield* Store.save({ turns: [answered, row("b")], sessions: [session], agentName: "Hermes" })

      expect(Option.getOrUndefined(yield* Store.turn(key("a")))).toEqual(answered)
      expect(Option.getOrUndefined(yield* Store.session(SESSION))).toEqual(session)
      expect(yield* Store.agentName).toBe("Hermes")
    }).pipe(Effect.provide(database())))

  it.effect("a saved row replaces the stored one whole", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      yield* Store.save({ turns: [row("a")], sessions: [] })
      const acked = row("a", { state: "acked", updated_at: millis(2000) })
      yield* Store.save({ turns: [acked], sessions: [], agentName: "Echo" })
      yield* Store.save({ turns: [], sessions: [], agentName: "Hermes" })

      expect(Option.getOrUndefined(yield* Store.turn(key("a")))).toEqual(acked)
      expect(yield* Store.agentName).toBe("Hermes")
    }).pipe(Effect.provide(database())))

  it.effect("open turns come oldest first, and steers by the turn they steer into", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      yield* Store.save({
        turns: [
          row("b", { created_at: millis(2000) }),
          row("a", { created_at: millis(1000) }),
          row("c", { created_at: millis(3000), steer_into: key("a") }),
          done("d", { created_at: millis(4000), steer_into: key("a") })
        ],
        sessions: []
      })

      expect((yield* Store.openTurns).map((r) => r.key)).toEqual([key("a"), key("b"), key("c")])
      expect((yield* Store.openSteersInto(key("a"))).map((r) => r.key)).toEqual([key("c")])
    }).pipe(Effect.provide(database())))

  it.effect("pruning deletes resolved turns last updated before the cutoff, and counts them", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      yield* Store.save({
        turns: [
          done("old", { updated_at: millis(100) }),
          { ...row("lost", { updated_at: millis(100) }), state: "unknown" },
          done("recent", { updated_at: millis(300) }),
          row("open", { updated_at: millis(100) })
        ],
        sessions: []
      })

      expect(yield* Store.save({ turns: [], sessions: [], pruneBefore: millis(200) })).toBe(2)
      expect(Option.isSome(yield* Store.turn(key("recent")))).toBe(true)
      expect(Option.isSome(yield* Store.turn(key("open")))).toBe(true)
      expect(Option.isNone(yield* Store.turn(key("old")))).toBe(true)
    }).pipe(Effect.provide(database())))
})
