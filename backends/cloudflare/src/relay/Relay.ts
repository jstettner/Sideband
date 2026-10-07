import type { AgentInfo, SessionState, Status, TurnState } from "@sideband/protocol"
import { Runner } from "@sideband/protocol"
import { DurableObject } from "cloudflare:workers"
import { Exit, Schema } from "effect"
import { isResolved, type Outcome, Store, type TurnRow } from "./store.ts"

/** How long `submit` holds the request open before answering `running`. */
const HOLD_MS = 25_000
/** Poll interval suggested to clients for a `running` turn. */
const RETRY_AFTER_MS = 1_000
/** A runner whose last `ping` is older than this is offline. */
const STALE_PING_MS = 45_000
/** After a reconnect, unresolved turns younger than this are re-sent; older ones become `unknown`. */
const RESEND_WINDOW_MS = 2 * 60_000
/** How long a session operation waits for the runner. */
const SESSION_OP_TIMEOUT_MS = 25_000

const UNKNOWN_MESSAGE = "Lost contact with the agent. The turn may or may not have run."

/** Close codes from protocol/runner.md. */
const CLOSE_REPLACED = 4000
const CLOSE_UNSUPPORTED_PROTOCOL = 4002

/** Per-socket state, kept with the socket across hibernation. */
interface Attachment {
  readonly connectedAt: number
  readonly hello?: { readonly runner_version: string; readonly agent: AgentInfo }
}

/**
 * RPC results: `value`, or why the request was `refused`. Errors are plain values because thrown
 * errors lose their type across RPC. One object type rather than a union, which the generated
 * stub types can't carry.
 */
export interface Reply<A, E extends string> {
  readonly value?: A
  readonly refused?: { readonly error: E; readonly message: string }
}

export interface SubmitTurn {
  readonly key: string
  readonly session: string
  readonly transcript: string
  readonly transcriptRaw?: string | undefined
  /** SHA-256 of the request payload, to detect a key reused for a different command. */
  readonly payloadHash: string
}

type SessionOpOutcome = Runner.SessionOpResult | Runner.SessionOpFailed

const ok = <A>(value: A) => ({ value })
const refuse = <E extends string>(error: E, message: string) => ({ refused: { error, message } })

const decodeMessage = Schema.decodeUnknownExit(Schema.fromJsonString(Runner.RunnerMessage))

/**
 * Rendezvous between clients and the runner (one instance per user). Clients call the RPC
 * methods through the Worker; the runner holds a hibernatable WebSocket. Only open requests
 * are kept in memory; everything else is in SQLite (see store.ts).
 */
export class Relay extends DurableObject<Cloudflare.Env> {
  private readonly store: Store
  /** Open `submit` calls waiting for a turn's outcome, by key. */
  private readonly turnWaiters = new Map<string, Set<() => void>>()
  /** Open `sessionOp` calls waiting for the runner, by op ID. */
  private readonly opWaiters = new Map<string, (outcome: SessionOpOutcome) => void>()

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.store = new Store(ctx.storage)
    // Heartbeats are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(Runner.HEARTBEAT_PING, Runner.HEARTBEAT_PONG))
  }

  // RPC

  async submit(turn: SubmitTurn): Promise<
    Reply<typeof TurnState.Encoded, "agent_offline" | "session_busy" | "idempotency_conflict">
  > {
    const runner = this.liveRunner()
    const existing = this.store.turn(turn.key)
    if (existing) {
      return existing.payload_hash === turn.payloadHash
        ? ok(this.turnState(existing))
        : refuse("idempotency_conflict", "This Idempotency-Key was already used for a different command.")
    }
    if (!runner) return refuse("agent_offline", "The agent is offline. Nothing was run.")
    if (this.store.session(turn.session)?.active_key) {
      return refuse("session_busy", "The agent is still working on the previous command. Nothing was run.")
    }

    this.store.claim(turn, Date.now())
    console.log(`turn ${turn.key} → runner (session ${turn.session})`)
    this.sendTurn(runner.ws, this.store.turn(turn.key)!)
    await this.waitForOutcome(turn.key, HOLD_MS)
    return ok(this.turnState(this.store.turn(turn.key)!))
  }

  async get(key: string): Promise<Reply<typeof TurnState.Encoded, "not_found">> {
    this.liveRunner()
    const row = this.store.turn(key)
    return row ? ok(this.turnState(row)) : refuse("not_found", `No turn ${key}.`)
  }

  async status(session: string): Promise<typeof Status.Encoded> {
    const live = this.liveRunner()
    const agentName = this.store.agentName()
    return {
      agent: { ...(agentName !== undefined ? { name: agentName } : {}), online: live !== undefined },
      session: this.sessionState(session)
    }
  }

  async sessionOp(session: string, op: "new" | "compact"): Promise<
    Reply<typeof SessionState.Encoded, "agent_offline" | "session_busy" | "not_supported" | "internal_error">
  > {
    const runner = this.liveRunner()
    if (!runner) return refuse("agent_offline", "The agent is offline. Nothing was run.")
    const current = this.store.session(session)
    if (current?.active_key) return refuse("session_busy", "The agent is still working on a command in this session.")

    const opId = crypto.randomUUID()
    const outcome = new Promise<SessionOpOutcome | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.opWaiters.delete(opId)
        resolve(undefined)
      }, SESSION_OP_TIMEOUT_MS)
      this.opWaiters.set(opId, (outcome) => {
        clearTimeout(timer)
        this.opWaiters.delete(opId)
        resolve(outcome)
      })
    })
    runner.ws.send(JSON.stringify(
      {
        type: "session_op",
        op_id: opId,
        op,
        session,
        ...(current?.agent_session_id ? { agent_session_id: current.agent_session_id } : {})
      } satisfies Runner.SessionOp
    ))

    const result = await outcome
    if (!result) return refuse("internal_error", "The runner didn't answer.")
    if (result.type === "session_op_failed") {
      return result.code === "not_supported"
        ? refuse("not_supported", result.message)
        : refuse("internal_error", result.message)
    }
    this.store.setAgentSession(session, result.agent_session_id, result.context, Date.now())
    return ok(this.sessionState(session))
  }

  // Runner WebSocket

  /** The runner's upgrade, already authenticated by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 400 })
    }
    for (const old of this.ctx.getWebSockets()) old.close(CLOSE_REPLACED, "replaced")

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ connectedAt: Date.now() } satisfies Attachment)
    console.log("runner connected")
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return
    if (message === Runner.HEARTBEAT_PING) return ws.send(Runner.HEARTBEAT_PONG)

    const decoded = decodeMessage(message)
    if (Exit.isFailure(decoded)) {
      if (messageType(message) === "hello") {
        console.warn("runner hello rejected: unsupported protocol")
        return ws.close(CLOSE_UNSUPPORTED_PROTOCOL, "unsupported_protocol")
      }
      console.warn(`ignoring runner message: ${message.slice(0, 200)}`)
      return
    }

    const msg = decoded.value
    switch (msg.type) {
      case "hello":
        return this.onHello(ws, msg)
      case "ack": {
        const row = this.store.turn(msg.key)
        if (row && (row.state === "pending" || row.state === "sent")) this.store.setState(msg.key, "acked", Date.now())
        return
      }
      case "result":
      case "needs_approval":
      case "turn_failed": {
        const row = this.store.turn(msg.key)
        // Duplicates (e.g. re-delivered after a reconnect) are ignored.
        if (!row || isResolved(row)) return
        console.log(`turn ${msg.key} ← ${msg.type}`)
        return this.resolve(row, msg)
      }
      case "session_op_result":
      case "session_op_failed":
        return this.opWaiters.get(msg.op_id)?.(msg)
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    console.log(`runner disconnected (${code} ${reason})`)
    try {
      ws.close()
    } catch {
      // already closed
    }
  }

  override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.warn(`runner socket error: ${String(error)}`)
  }

  /**
   * First message of a connection. Turns the runner is still executing are left alone; other
   * unresolved turns are re-sent if recent (the runner never runs a key twice) or marked
   * `unknown`, so a command never runs late by surprise.
   */
  private onHello(ws: WebSocket, hello: Runner.Hello): void {
    const attachment = ws.deserializeAttachment() as Attachment
    ws.serializeAttachment({
      ...attachment,
      hello: { runner_version: hello.runner_version, agent: hello.agent }
    } satisfies Attachment)
    this.store.setAgentName(hello.agent.name)
    console.log(`runner hello: ${hello.agent.name} (runner ${hello.runner_version}), in flight: ${hello.in_flight.length}`)

    const inFlight = new Set(hello.in_flight)
    const now = Date.now()
    for (const row of this.store.unresolvedTurns()) {
      if (inFlight.has(row.key)) continue
      if (now - row.created_at < RESEND_WINDOW_MS) {
        console.log(`turn ${row.key} re-sent after reconnect`)
        this.sendTurn(ws, row)
      } else {
        this.resolve(row, undefined)
      }
    }
  }

  private sendTurn(ws: WebSocket, row: TurnRow): void {
    const agentSessionId = this.store.session(row.session)?.agent_session_id
    ws.send(JSON.stringify(
      {
        type: "turn",
        key: row.key,
        session: row.session,
        ...(agentSessionId ? { agent_session_id: agentSessionId } : {}),
        transcript: row.transcript
      } satisfies Runner.Turn
    ))
    this.store.setState(row.key, "sent", Date.now())
  }

  /** Stores the outcome (`undefined`: lost) and wakes anyone waiting on it. */
  private resolve(row: TurnRow, outcome: Outcome | undefined): void {
    this.store.resolve(row, outcome, Date.now())
    if (!outcome) console.log(`turn ${row.key} → unknown`)
    for (const wake of [...(this.turnWaiters.get(row.key) ?? [])]) wake()
  }

  private waitForOutcome(key: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.turnWaiters.get(key) ?? new Set()
      this.turnWaiters.set(key, waiters)
      const wake = () => {
        clearTimeout(timer)
        waiters.delete(wake)
        if (waiters.size === 0) this.turnWaiters.delete(key)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      waiters.add(wake)
    })
  }

  /** The connected runner that has said hello, if any, and whether its heartbeat is fresh. */
  private runner(): { ws: WebSocket; online: boolean } | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (ws.readyState !== WebSocket.OPEN || !attachment?.hello) continue
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? attachment.connectedAt
      return { ws, online: Date.now() - lastPing <= STALE_PING_MS }
    }
    return undefined
  }

  /**
   * The runner, if it's online. If it isn't, nothing will resolve old turns until it comes
   * back, so turns past the re-send window are marked `unknown` now (pollers stop waiting).
   */
  private liveRunner(): { ws: WebSocket } | undefined {
    const runner = this.runner()
    if (runner?.online) return runner
    const now = Date.now()
    for (const row of this.store.unresolvedTurns()) {
      if (now - row.created_at >= RESEND_WINDOW_MS) this.resolve(row, undefined)
    }
    return undefined
  }

  private turnState(row: TurnRow): typeof TurnState.Encoded {
    const base = { idempotency_key: row.key, session: row.session, transcript: row.transcript }
    if (row.state === "unknown") return { status: "unknown", ...base, message: UNKNOWN_MESSAGE }
    if (row.state !== "done") return { status: "running", ...base, retry_after_ms: RETRY_AFTER_MS }

    const outcome = JSON.parse(row.outcome_json!) as Outcome
    switch (outcome.type) {
      case "result": {
        const { type: _type, key: _key, agent_session_id: _agentSessionId, ...answer } = outcome
        return {
          status: "completed",
          ...base,
          ...(row.transcript_raw !== null ? { transcript_raw: row.transcript_raw } : {}),
          ...answer
        }
      }
      case "needs_approval":
        return { status: "needs_approval", ...base, message: outcome.message }
      case "turn_failed":
        return { status: "failed", ...base, code: outcome.code, message: outcome.message }
    }
  }

  private sessionState(name: string): typeof SessionState.Encoded {
    const row = this.store.session(name)
    return {
      name,
      busy: row?.active_key != null,
      ...(row?.context_used != null && row.context_limit != null
        ? { context: { used_tokens: row.context_used, limit_tokens: row.context_limit } }
        : {}),
      ...(row?.last_activity != null ? { last_activity: new Date(row.last_activity).toISOString() } : {})
    }
  }
}

/** `type` of a JSON message that failed to decode, to recognize a hello we can't accept. */
function messageType(message: string): unknown {
  try {
    return (JSON.parse(message) as { type?: unknown }).type
  } catch {
    return undefined
  }
}
