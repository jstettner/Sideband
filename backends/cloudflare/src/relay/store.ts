import type { Runner } from "@sideband/protocol"

/**
 * The relay's SQLite storage. Everything that must survive hibernation lives here; only
 * `Relay.ts` uses it. Timestamps are epoch milliseconds.
 */

/** `pending` → `sent` → `acked` → `done` (outcome stored) or `unknown` (outcome lost). */
export type TurnStatus = "pending" | "sent" | "acked" | "done" | "unknown"

/** What the runner reported for a turn, stored as `outcome_json`. */
export type Outcome = Runner.TurnResult | Runner.TurnNeedsApproval | Runner.TurnFailed | Runner.TurnMerged

export interface TurnRow {
  readonly key: string
  readonly session: string
  readonly payload_hash: string
  readonly transcript: string
  readonly transcript_raw: string | null
  readonly state: TurnStatus
  readonly outcome_json: string | null
  /** Key of the turn this one was sent to steer, if it was a steer. */
  readonly steer_into: string | null
  readonly created_at: number
  readonly updated_at: number
}

export interface SessionRow {
  readonly name: string
  readonly agent_session_id: string | null
  readonly active_key: string | null
  readonly context_used: number | null
  readonly context_limit: number | null
  readonly last_activity: number | null
}

export const isResolved = (row: TurnRow): boolean => row.state === "done" || row.state === "unknown"

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

export class Store {
  private readonly sql: SqlStorage
  private readonly kv: SyncKvStorage

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql
    this.kv = storage.kv
    storage.transactionSync(() => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
      const version = this.sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0]?.version ?? 0
      for (const migration of migrations.slice(version)) this.sql.exec(migration)
      this.sql.exec("DELETE FROM schema_version")
      this.sql.exec("INSERT INTO schema_version (version) VALUES (?)", migrations.length)
    })
  }

  agentName(): string | undefined {
    return this.kv.get<string>(AGENT_NAME)
  }

  setAgentName(name: string): void {
    this.kv.put(AGENT_NAME, name)
  }

  turn(key: string): TurnRow | undefined {
    return this.sql.exec<TurnRow & Record<string, SqlStorageValue>>("SELECT * FROM turns WHERE key = ?", key)
      .toArray()[0]
  }

  /** Turns still waiting for an outcome, oldest first. */
  unresolvedTurns(): Array<TurnRow> {
    return this.sql.exec<TurnRow & Record<string, SqlStorageValue>>(
      "SELECT * FROM turns WHERE state IN ('pending', 'sent', 'acked') ORDER BY created_at"
    ).toArray()
  }

  /**
   * Inserts a new turn and makes it its session's active turn. A steer (`steerInto`) leaves the
   * active turn alone: it's answered through that turn.
   */
  claim(turn: {
    readonly key: string
    readonly session: string
    readonly payloadHash: string
    readonly transcript: string
    readonly transcriptRaw?: string | undefined
  }, now: number, steerInto?: string): void {
    this.sql.exec(
      `INSERT INTO turns (key, session, payload_hash, transcript, transcript_raw, state, steer_into, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      turn.key,
      turn.session,
      turn.payloadHash,
      turn.transcript,
      turn.transcriptRaw ?? null,
      steerInto ?? null,
      now,
      now
    )
    if (steerInto !== undefined) {
      this.sql.exec("UPDATE sessions SET last_activity = ? WHERE name = ?", now, turn.session)
      return
    }
    this.sql.exec(
      `INSERT INTO sessions (name, active_key, last_activity) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET active_key = excluded.active_key, last_activity = excluded.last_activity`,
      turn.session,
      turn.key,
      now
    )
  }

  setState(key: string, state: "sent" | "acked", now: number): void {
    this.sql.exec("UPDATE turns SET state = ?, updated_at = ? WHERE key = ?", state, now, key)
  }

  /**
   * Stores the outcome (or marks it lost). If `row` was its session's active turn, the latest
   * unresolved steer into it takes over (the runner may still run it on its own); otherwise the
   * session is free for the next turn.
   */
  resolve(row: TurnRow, outcome: Outcome | undefined, now: number): void {
    this.sql.exec(
      "UPDATE turns SET state = ?, outcome_json = ?, updated_at = ? WHERE key = ?",
      outcome ? "done" : "unknown",
      outcome ? JSON.stringify(outcome) : null,
      now,
      row.key
    )
    this.sql.exec(
      `UPDATE sessions SET
         active_key = (SELECT key FROM turns WHERE steer_into = ? AND state IN ('pending', 'sent', 'acked')
                       ORDER BY created_at DESC LIMIT 1),
         last_activity = ?
       WHERE name = ? AND active_key = ?`,
      row.key,
      now,
      row.session,
      row.key
    )
    if (outcome && (outcome.type === "result" || outcome.type === "needs_approval")) {
      this.setAgentSession(row.session, outcome.agent_session_id, outcome.type === "result" ? outcome.context : undefined, now)
    }
  }

  /** Deletes resolved turns last updated before `before`. Returns how many. */
  prune(before: number): number {
    return this.sql.exec("DELETE FROM turns WHERE state IN ('done', 'unknown') AND updated_at < ?", before)
      .rowsWritten
  }

  session(name: string): SessionRow | undefined {
    return this.sql.exec<SessionRow & Record<string, SqlStorageValue>>("SELECT * FROM sessions WHERE name = ?", name)
      .toArray()[0]
  }

  /**
   * Records the agent session now behind `name`, and its context usage if reported. Keeps the
   * last known usage when none is reported, unless the agent session changed.
   */
  setAgentSession(
    name: string,
    agentSessionId: string,
    context: { readonly used_tokens: number; readonly limit_tokens: number } | undefined,
    now: number
  ): void {
    this.sql.exec(
      `INSERT INTO sessions (name, agent_session_id, context_used, context_limit, last_activity) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         agent_session_id = excluded.agent_session_id,
         context_used = CASE WHEN excluded.context_used IS NULL AND sessions.agent_session_id IS excluded.agent_session_id
           THEN sessions.context_used ELSE excluded.context_used END,
         context_limit = CASE WHEN excluded.context_used IS NULL AND sessions.agent_session_id IS excluded.agent_session_id
           THEN sessions.context_limit ELSE excluded.context_limit END,
         last_activity = excluded.last_activity`,
      name,
      agentSessionId,
      context?.used_tokens ?? null,
      context?.limit_tokens ?? null,
      now
    )
  }
}
