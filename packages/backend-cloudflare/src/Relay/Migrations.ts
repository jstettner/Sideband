/**
 * The Relay's SQLite schema, as `Migrator.fromRecord` migrations. Every object has its own database, so
 * each object migrates itself when it activates (`RelayDO.ts`).
 *
 * A migration is editable until it reaches `main`; after that it is forward-only. `Migrator` records
 * applied ids without a checksum, so editing an applied migration silently does nothing on any object
 * that already ran it. Fix a bad applied migration with a new one.
 */
import { Effect, Option, Schema } from "effect"
import { Migrator, SqlClient, SqlSchema } from "effect/sql"

/** The table `Migrator` records applied migrations in. */
export const TABLE = "effect_sql_migrations"

/**
 * `turns` (one row per idempotency key), `sessions` (one row per session name), and `relay_meta`. The checks
 * keep a row to one of the states `Lifecycle` models: only a `done` turn has an outcome.
 */
const relay = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE turns (
      key            TEXT PRIMARY KEY,
      session        TEXT NOT NULL,
      payload_hash   TEXT NOT NULL,
      transcript     TEXT NOT NULL,
      transcript_raw TEXT,
      state          TEXT NOT NULL CHECK (state IN ('sent', 'acked', 'done', 'unknown')),
      outcome_json   TEXT CHECK ((state = 'done') = (outcome_json IS NOT NULL)),
      steer_into     TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    )
  `
  yield* sql`CREATE INDEX turns_state ON turns (state)`
  yield* sql`CREATE INDEX turns_steer_into ON turns (steer_into)`
  yield* sql`
    CREATE TABLE sessions (
      name             TEXT PRIMARY KEY,
      agent_session_id TEXT,
      active_key       TEXT,
      context_json     TEXT,
      last_activity    INTEGER
    )
  `
  // One row per key; currently only `agent_name`, the agent behind the last runner that said hello.
  yield* sql`CREATE TABLE relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
})

/** Every migration, keyed `<id>_<name>`. Append only; ids are zero-padded so keys sort. */
export const migrations = {
  "0001_relay": relay
} satisfies Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>

/** Applies every pending migration in one transaction, in id order. */
export const run = Migrator.make({})({ loader: Migrator.fromRecord(migrations), table: TABLE })

/** The `<id>_<name>` key of the newest migration in {@link migrations}. */
export const latest = Object.keys(migrations).toSorted().at(-1)

const LatestRow = Schema.Struct({ id: Schema.Int, name: Schema.String })

/** The `<id>_<name>` key of the latest applied migration, or `undefined` before the first. */
export const latestApplied = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: LatestRow,
    execute: () =>
      sql`SELECT migration_id AS id, name FROM ${sql(TABLE)} ORDER BY migration_id DESC LIMIT 1`.withoutTransform
  })(undefined)

  return Option.getOrUndefined(Option.map(row, ({ id, name }) => `${String(id).padStart(4, "0")}_${name}`))
}).pipe(Effect.withSpan("Migrations.latestApplied"))
