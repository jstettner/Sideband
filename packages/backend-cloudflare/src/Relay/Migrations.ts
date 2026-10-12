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
 * The schema objects had before `Migrator`: `schema_version` counted how many of these had run. Kept
 * verbatim so `0001_relay` brings an object at any of those versions to the same schema.
 */
const legacy: ReadonlyArray<Effect.Effect<void, unknown, SqlClient.SqlClient>> = [
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS turns (
        key            TEXT PRIMARY KEY,
        session        TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        transcript     TEXT NOT NULL,
        transcript_raw TEXT,
        state          TEXT NOT NULL,
        outcome_json   TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX IF NOT EXISTS turns_state ON turns (state)`
    yield* sql`
      CREATE TABLE IF NOT EXISTS sessions (
        name             TEXT PRIMARY KEY,
        agent_session_id TEXT,
        active_key       TEXT,
        context_used     INTEGER,
        context_limit    INTEGER,
        last_activity    INTEGER
      )
    `
  }),
  // Steering.
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE turns ADD COLUMN steer_into TEXT`
    yield* sql`CREATE INDEX turns_steer_into ON turns (steer_into)`
  })
]

/** How many {@link legacy} steps an object ran, or `undefined` for an object created after them. */
const legacyVersion = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const table = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ name: Schema.String }),
    execute: () => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`
  })(undefined)

  if (Option.isNone(table)) return undefined

  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ version: Schema.Int }),
    execute: () => sql`SELECT version FROM schema_version`
  })(undefined)

  return Option.match(row, { onNone: () => 0, onSome: ({ version }) => version })
})

/**
 * `turns` (one row per idempotency key), `sessions` (one row per session name), and `relay_meta`. An object
 * created before `Migrator` keeps its rows: the legacy steps it hadn't run yet run now. Its `schema_version`
 * then says every legacy step ran, so the code that came before `Migrator` still starts against it (it runs
 * nothing and ignores the tables it doesn't know).
 */
const relay = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const version = yield* legacyVersion

  for (const step of legacy.slice(version ?? 0)) yield* step

  if (version !== undefined) yield* sql`UPDATE schema_version SET version = ${legacy.length}`

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
