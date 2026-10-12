/**
 * The Relay's SQL on a real SQLite (`node:sqlite`): the migrations, including adopting an object created
 * before `Migrator`, and the store's reads and writes. Durable Object storage is SQLite too; what only the
 * object can show (transactions over its storage, hibernation) is in `workers.test.ts`.
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type * as Lifecycle from "../src/Relay/Lifecycle.ts"
import * as Migrations from "../src/Relay/Migrations.ts"
import * as Store from "../src/Relay/Store.ts"
import { key, result, SESSION } from "./Harness.ts"

const database = () => Layer.fresh(SqliteClient.layer({ filename: ":memory:" }))

const row = (name: string, fields: Partial<Lifecycle.TurnRow> = {}): Lifecycle.TurnRow => ({
  key: key(name),
  session: SESSION,
  payload_hash: `hash-${name}`,
  transcript: `say ${name}`,
  transcript_raw: null,
  state: "sent",
  outcome: null,
  steer_into: null,
  created_at: 1000,
  updated_at: 1000,
  ...fields
})

const tables = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`

  return rows.map(({ name }) => name)
})

/** An object's schema as the pre-`Migrator` code left it at `version`, with one turn row. */
const legacy = (version: 1 | 2) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE schema_version (version INTEGER NOT NULL)`
    yield* sql`INSERT INTO schema_version (version) VALUES (${version})`
    yield* sql`
      CREATE TABLE turns (
        key TEXT PRIMARY KEY, session TEXT NOT NULL, payload_hash TEXT NOT NULL, transcript TEXT NOT NULL,
        transcript_raw TEXT, state TEXT NOT NULL, outcome_json TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX turns_state ON turns (state)`
    yield* sql`
      CREATE TABLE sessions (
        name TEXT PRIMARY KEY, agent_session_id TEXT, active_key TEXT, context_used INTEGER, context_limit INTEGER,
        last_activity INTEGER
      )
    `

    if (version === 2) {
      yield* sql`ALTER TABLE turns ADD COLUMN steer_into TEXT`
      yield* sql`CREATE INDEX turns_steer_into ON turns (steer_into)`
    }

    yield* sql`
      INSERT INTO turns (key, session, payload_hash, transcript, state, outcome_json, created_at, updated_at)
      VALUES (${key("old")}, ${SESSION}, 'hash', 'say old', 'done', ${JSON.stringify(result("old"))}, 1, 2)
    `
    yield* sql`INSERT INTO sessions (name, agent_session_id) VALUES (${SESSION}, 'agent-session-1')`
  })

describe("Migrations", () => {
  it.effect("a fresh object gets the relay's tables, and the newest migration is applied", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      expect(yield* tables).toEqual(expect.arrayContaining(["relay_meta", "sessions", "turns"]))
      expect(yield* Migrations.latestApplied).toBe(Migrations.latest)
    }).pipe(Effect.provide(database())))

  for (const version of [1, 2] as const) {
    it.effect(`an object created before Migrator (schema_version ${version}) keeps its rows`, () =>
      Effect.gen(function*() {
        yield* legacy(version)
        yield* Migrations.run

        expect(Option.getOrUndefined(yield* Store.turn(key("old")))).toMatchObject({
          state: "done",
          steer_into: null,
          outcome: result("old")
        })
        expect(Option.getOrUndefined(yield* Store.session(SESSION))).toMatchObject({
          agent_session_id: "agent-session-1"
        })
      }).pipe(Effect.provide(database())))
  }

  it.effect("an adopted object still says every legacy step ran, so the code before Migrator still starts", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* legacy(1)
      yield* Migrations.run

      expect(yield* sql<{ readonly version: number }>`SELECT version FROM schema_version`).toEqual([{ version: 2 }])
    }).pipe(Effect.provide(database())))

  it.effect("a fresh object has no schema_version", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      expect(yield* tables).not.toContain("schema_version")
    }).pipe(Effect.provide(database())))

  it.effect("running the migrations again applies nothing", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      expect(yield* Migrations.run).toEqual([])
    }).pipe(Effect.provide(database())))
})

describe("Store", () => {
  it.effect("saved rows read back as they were written, outcome included", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      const done = row("a", { state: "done", outcome: result("a"), transcript_raw: "say a." })

      const session: Lifecycle.SessionRow = {
        name: SESSION,
        agent_session_id: "s1",
        active_key: key("b"),
        context_used: 5,
        context_limit: 9,
        last_activity: 1000
      }

      yield* Store.save({ turns: [done, row("b")], sessions: [session], agentName: "Hermes" })

      expect(Option.getOrUndefined(yield* Store.turn(key("a")))).toEqual(done)
      expect(Option.getOrUndefined(yield* Store.session(SESSION))).toEqual(session)
      expect(yield* Store.agentName).toBe("Hermes")
    }).pipe(Effect.provide(database())))

  it.effect("a saved row replaces the stored one whole", () =>
    Effect.gen(function*() {
      yield* Migrations.run
      yield* Store.save({ turns: [row("a")], sessions: [] })
      const acked = row("a", { state: "acked", updated_at: 2000 })
      yield* Store.save({ turns: [acked], sessions: [], agentName: "Echo" })
      yield* Store.save({ turns: [], sessions: [], agentName: "Hermes" })

      expect(Option.getOrUndefined(yield* Store.turn(key("a")))).toEqual(acked)
      expect(yield* Store.agentName).toBe("Hermes")
    }).pipe(Effect.provide(database())))

  it.effect("unresolved turns come oldest first, and steers by the turn they steer into", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      yield* Store.save({
        turns: [
          row("b", { created_at: 2000 }),
          row("a", { created_at: 1000 }),
          row("c", { created_at: 3000, steer_into: key("a") }),
          row("d", { created_at: 4000, steer_into: key("a"), state: "done", outcome: result("d") })
        ],
        sessions: []
      })

      expect((yield* Store.unresolvedTurns).map((r) => r.key)).toEqual([key("a"), key("b"), key("c")])
      expect((yield* Store.unresolvedSteersInto(key("a"))).map((r) => r.key)).toEqual([key("c")])
    }).pipe(Effect.provide(database())))

  it.effect("pruning deletes resolved turns last updated before the cutoff, and counts them", () =>
    Effect.gen(function*() {
      yield* Migrations.run

      yield* Store.save({
        turns: [
          row("old", { state: "done", outcome: result("old"), updated_at: 100 }),
          row("lost", { state: "unknown", updated_at: 100 }),
          row("recent", { state: "done", outcome: result("recent"), updated_at: 300 }),
          row("open", { updated_at: 100 })
        ],
        sessions: []
      })

      expect(yield* Store.save({ turns: [], sessions: [], pruneBefore: 200 })).toBe(2)
      expect(Option.isSome(yield* Store.turn(key("recent")))).toBe(true)
      expect(Option.isSome(yield* Store.turn(key("open")))).toBe(true)
      expect(Option.isNone(yield* Store.turn(key("old")))).toBe(true)
    }).pipe(Effect.provide(database())))
})
