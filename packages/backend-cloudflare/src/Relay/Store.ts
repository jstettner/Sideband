/* oxlint-disable -- Replaced by SQL functions over Effect's SqlClient. */
import { Schema } from "effect"
import { SessionRow, type Source, TurnRow, type Writes } from "./Lifecycle.ts"

/**
 * The relay's SQLite storage: the rows `Lifecycle` reads and the writes its steps produce. Everything that
 * must survive hibernation lives here; only `Relay.ts` uses it. Timestamps are epoch milliseconds.
 */

/**
 * Schema changes, applied in order. `schema_version` records how many have run, so each runs
 * once per object. (Durable Objects don't allow `PRAGMA user_version`.) Append only; never edit
 * one that has shipped.
 */
const migrations: ReadonlyArray<string> = [
  // 1: turns and sessions. IF NOT EXISTS: the first deploy created these before versioning.
  `CREATE TABLE IF NOT EXISTS turns (
     key            TEXT PRIMARY KEY,
     session        TEXT NOT NULL,
     payload_hash   TEXT NOT NULL,
     transcript     TEXT NOT NULL,
     transcript_raw TEXT,
     state          TEXT NOT NULL,
     outcome_json   TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS turns_state ON turns (state);
   CREATE TABLE IF NOT EXISTS sessions (
     name             TEXT PRIMARY KEY,
     agent_session_id TEXT,
     active_key       TEXT,
     context_used     INTEGER,
     context_limit    INTEGER,
     last_activity    INTEGER
   );`,
  // 2: steering
  `ALTER TABLE turns ADD COLUMN steer_into TEXT;
   CREATE INDEX turns_steer_into ON turns (steer_into);`
]

/** `storage.kv` key: the agent behind the last runner that said hello, for status while offline. */
const AGENT_NAME = "agent_name"

const decodeTurn = Schema.decodeUnknownSync(TurnRow)
const encodeTurn = Schema.encodeSync(TurnRow)
const decodeSession = Schema.decodeUnknownSync(SessionRow)

export class Store implements Source {
  private readonly storage: DurableObjectStorage
  private readonly sql: SqlStorage
  private readonly kv: SyncKvStorage

  constructor(storage: DurableObjectStorage) {
    this.storage = storage
    this.sql = storage.sql
    this.kv = storage.kv
    storage.transactionSync(() => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
      const version = this.sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0]?.version ??
        0
      for (const migration of migrations.slice(version)) this.sql.exec(migration)
      this.sql.exec("DELETE FROM schema_version")
      this.sql.exec("INSERT INTO schema_version (version) VALUES (?)", migrations.length)
    })
  }

  agentName(): string | undefined {
    return this.kv.get<string>(AGENT_NAME)
  }

  turn(key: string): TurnRow | undefined {
    const row = this.sql.exec("SELECT * FROM turns WHERE key = ?", key).toArray()[0]
    return row === undefined ? undefined : decodeTurn(row)
  }

  /** Turns still waiting for an outcome, oldest first. */
  unresolvedTurns(): ReadonlyArray<TurnRow> {
    return this.sql.exec("SELECT * FROM turns WHERE state IN ('pending', 'sent', 'acked') ORDER BY created_at")
      .toArray()
      .map((row) => decodeTurn(row))
  }

  unresolvedSteersInto(key: string): ReadonlyArray<TurnRow> {
    return this.sql.exec(
      "SELECT * FROM turns WHERE steer_into = ? AND state IN ('pending', 'sent', 'acked') ORDER BY created_at",
      key
    ).toArray().map((row) => decodeTurn(row))
  }

  session(name: string): SessionRow | undefined {
    const row = this.sql.exec("SELECT * FROM sessions WHERE name = ?", name).toArray()[0]
    return row === undefined ? undefined : decodeSession(row)
  }

  /** Writes a step's rows in one transaction. Returns how many turns were pruned. */
  save(writes: Writes): number {
    return this.storage.transactionSync(() => {
      for (const turn of writes.turns) {
        const row = encodeTurn(turn)
        this.sql.exec(
          `INSERT INTO turns (key, session, payload_hash, transcript, transcript_raw, state, outcome_json, steer_into,
                              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             session = excluded.session, payload_hash = excluded.payload_hash, transcript = excluded.transcript,
             transcript_raw = excluded.transcript_raw, state = excluded.state, outcome_json = excluded.outcome_json,
             steer_into = excluded.steer_into, created_at = excluded.created_at, updated_at = excluded.updated_at`,
          row.key,
          row.session,
          row.payload_hash,
          row.transcript,
          row.transcript_raw,
          row.state,
          row.outcome_json,
          row.steer_into,
          row.created_at,
          row.updated_at
        )
      }
      for (const session of writes.sessions) {
        this.sql.exec(
          `INSERT INTO sessions (name, agent_session_id, active_key, context_used, context_limit, last_activity)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET
             agent_session_id = excluded.agent_session_id, active_key = excluded.active_key,
             context_used = excluded.context_used, context_limit = excluded.context_limit,
             last_activity = excluded.last_activity`,
          session.name,
          session.agent_session_id,
          session.active_key,
          session.context_used,
          session.context_limit,
          session.last_activity
        )
      }
      if (writes.agentName !== undefined) this.kv.put(AGENT_NAME, writes.agentName)
      if (writes.pruneBefore === undefined) return 0
      return this.sql.exec(
        "DELETE FROM turns WHERE state IN ('done', 'unknown') AND updated_at < ?",
        writes.pruneBefore
      ).rowsWritten
    })
  }
}
