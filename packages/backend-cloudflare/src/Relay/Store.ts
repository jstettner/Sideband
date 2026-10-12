/**
 * The Relay's SQLite: the rows `Lifecycle.read` loads, and one `save` of the rows a step writes. Plain
 * functions over `SqlClient`, so nothing here knows it runs in a Durable Object; the schema is
 * `Migrations.ts`. Timestamps are epoch milliseconds.
 */
import { Common } from "@sideband/protocol"
import { Effect, Option, Schema } from "effect"
import { SqlClient, type SqlError, SqlSchema } from "effect/sql"
import { OpenTurnRow, SessionRow, type Source, TurnRow, type Writes } from "./Lifecycle.ts"

/** `relay_meta` key: the agent behind the last runner that said hello, for status while offline. */
const AGENT_NAME = "agent_name"

export const turn = Effect.fn("Store.turn")(function*(key: Common.IdempotencyKey) {
  const sql = yield* SqlClient.SqlClient

  return yield* SqlSchema.findOneOption({
    Request: Common.IdempotencyKey,
    Result: TurnRow,
    execute: (k) => sql`SELECT * FROM turns WHERE key = ${k}`
  })(key)
})

/** Turns still waiting for an outcome, oldest first. */
export const openTurns = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: OpenTurnRow,
    execute: () => sql`SELECT * FROM turns WHERE state IN ('sent', 'acked') ORDER BY created_at`
  })(undefined)
}).pipe(Effect.withSpan("Store.openTurns"))

/** Open steers into the turn `key`, oldest first. */
export const openSteersInto = Effect.fn("Store.openSteersInto")(function*(key: Common.IdempotencyKey) {
  const sql = yield* SqlClient.SqlClient

  return yield* SqlSchema.findAll({
    Request: Common.IdempotencyKey,
    Result: OpenTurnRow,
    execute: (k) => sql`SELECT * FROM turns WHERE steer_into = ${k} AND state IN ('sent', 'acked') ORDER BY created_at`
  })(key)
})

export const session = Effect.fn("Store.session")(function*(name: Common.SessionName) {
  const sql = yield* SqlClient.SqlClient

  return yield* SqlSchema.findOneOption({
    Request: Common.SessionName,
    Result: SessionRow,
    execute: (n) => sql`SELECT * FROM sessions WHERE name = ${n}`
  })(name)
})

/** The rows `Lifecycle.read` loads, from this object's SQLite. */
export const source: Source<SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient> = {
  turn,
  session,
  openTurns,
  openSteersInto
}

export const agentName = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const row = yield* SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ value: Schema.String }),
    execute: (k) => sql`SELECT value FROM relay_meta WHERE key = ${k}`
  })(AGENT_NAME)

  return Option.getOrUndefined(Option.map(row, ({ value }) => value))
}).pipe(Effect.withSpan("Store.agentName"))

/** Writes a step's rows (whole-row upserts). Returns how many turns were pruned. */
export const save = Effect.fn("Store.save")(function*(writes: Writes) {
  const sql = yield* SqlClient.SqlClient

  for (const row of writes.turns) {
    const encoded = yield* Schema.encodeEffect(TurnRow)(row)

    yield* sql`
      INSERT INTO turns ${sql.insert(encoded)}
      ON CONFLICT (key) DO UPDATE SET
        session = excluded.session,
        payload_hash = excluded.payload_hash,
        transcript = excluded.transcript,
        transcript_raw = excluded.transcript_raw,
        state = excluded.state,
        outcome_json = excluded.outcome_json,
        steer_into = excluded.steer_into,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `
  }

  for (const row of writes.sessions) {
    const encoded = yield* Schema.encodeEffect(SessionRow)(row)

    yield* sql`
      INSERT INTO sessions ${sql.insert(encoded)}
      ON CONFLICT (name) DO UPDATE SET
        agent_session_id = excluded.agent_session_id,
        active_key = excluded.active_key,
        context_json = excluded.context_json,
        last_activity = excluded.last_activity
    `
  }

  if (writes.agentName !== undefined) {
    yield* sql`
      INSERT INTO relay_meta (key, value) VALUES (${AGENT_NAME}, ${writes.agentName})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `
  }

  if (writes.pruneBefore === undefined) return 0

  const pruned = yield* sql`
    DELETE FROM turns WHERE state IN ('done', 'unknown') AND updated_at < ${writes.pruneBefore} RETURNING key
  `

  return pruned.length
})
