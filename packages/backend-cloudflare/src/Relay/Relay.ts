/* oxlint-disable -- Replaced by an Effect Durable Object. */
import { Runner, type Status, type Turn } from "@sideband/protocol"
import { DurableObject } from "cloudflare:workers"
import { Duration, Schema } from "effect"
import * as Lifecycle from "./Lifecycle.ts"
import { Store } from "./Store.ts"

/**
 * RPC results: `value`, or why the request was `refused`. Errors are plain values because thrown
 * errors lose their type across RPC. One object type rather than a union, which the generated
 * stub types can't carry.
 */
export interface Reply<A, E extends string> {
  readonly value?: A
  readonly refused?: { readonly error: E; readonly message: string }
}

type SubmitReply = Reply<typeof Turn.TurnState.Encoded, "agent_offline" | "session_busy" | "idempotency_conflict">
type SessionOpRpcReply = Reply<
  typeof Status.SessionState.Encoded,
  "agent_offline" | "session_busy" | "not_supported" | "internal_error"
>

const ok = <A>(value: A) => ({ value })
const refuse = <E extends string>(error: E, message: string) => ({ refused: { error, message } })

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Runner.RelayMessage))

/**
 * Rendezvous between clients and the runner (one instance per user). Clients call the RPC
 * methods through the Worker; the runner holds a hibernatable WebSocket. Only open requests
 * are kept in memory; everything else is in SQLite (see Store.ts).
 *
 * Every event goes through `run`: read its rows, step (`Lifecycle`, pure), save, act.
 */
export class Relay extends DurableObject<Cloudflare.Env> {
  private readonly store: Store
  /** Open `submit` calls waiting for a turn's outcome, by key. */
  private readonly turnWaiters = new Map<string, Set<() => void>>()
  /** Open `sessionOp` calls waiting for the runner, by op ID. */
  private readonly opWaiters = new Map<
    string,
    { readonly session: string; readonly settle: (reply: Lifecycle.SessionOpReply) => void }
  >()

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    this.store = new Store(ctx.storage)
    // Heartbeats are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(Runner.HEARTBEAT_PING, Runner.HEARTBEAT_PONG))
    void ctx.blockConcurrencyWhile(async () => {
      if (await ctx.storage.getAlarm() === null) {
        await ctx.storage.setAlarm(Date.now() + Duration.toMillis(Lifecycle.CLEANUP_INTERVAL))
      }
    })
  }

  // RPC

  async submit(turn: Lifecycle.SubmitTurn): Promise<SubmitReply> {
    const live = this.liveRunner()
    const answer = this.run(
      Lifecycle.Event.cases.Submit.make({ turn, runner: live?.runner }),
      (slice, now) => Lifecycle.submit(slice, turn, live?.runner, now),
      live?.ws
    )

    return Lifecycle.SubmitAnswer.match(answer, {
      Replay: async ({ row }): Promise<SubmitReply> => ok(Lifecycle.turnState(row)),
      Conflict: async (): Promise<SubmitReply> =>
        refuse("idempotency_conflict", "This Idempotency-Key was already used for a different command."),
      Offline: async (): Promise<SubmitReply> => refuse("agent_offline", "The agent is offline. Nothing was run."),
      Busy: async (): Promise<SubmitReply> =>
        refuse("session_busy", "The agent is still working on the previous command. Nothing was run."),
      Hold: async ({ key }): Promise<SubmitReply> => {
        await this.waitForOutcome(key, Duration.toMillis(Lifecycle.HOLD))
        return ok(Lifecycle.turnState(this.store.turn(key)!))
      }
    })
  }

  async get(key: string): Promise<Reply<typeof Turn.TurnState.Encoded, "not_found">> {
    this.liveRunner()
    const row = this.store.turn(key)
    return row ? ok(Lifecycle.turnState(row)) : refuse("not_found", `No turn ${key}.`)
  }

  async status(session: string): Promise<typeof Status.Status.Encoded> {
    const live = this.liveRunner()
    return Lifecycle.status(
      this.store.agentName(),
      live !== undefined,
      Lifecycle.sessionState(session, this.store.session(session))
    )
  }

  async sessionOp(session: string, op: "new" | "compact"): Promise<SessionOpRpcReply> {
    const live = this.liveRunner()
    const opId = crypto.randomUUID()
    const answer = this.run(
      Lifecycle.Event.cases.SessionOp.make({ session, op, opId, runner: live?.runner }),
      (slice) => Lifecycle.sessionOp(slice, { session, op, opId }, live?.runner),
      live?.ws
    )

    return Lifecycle.SessionOpAnswer.match(answer, {
      Offline: async (): Promise<SessionOpRpcReply> =>
        refuse("agent_offline", "The agent is offline. Nothing was run."),
      Busy: async (): Promise<SessionOpRpcReply> =>
        refuse("session_busy", "The agent is still working on a command in this session."),
      Wait: async (): Promise<SessionOpRpcReply> => {
        const reply = await this.waitForAnswer(opId, session)
        return Lifecycle.SessionOpReply.match(reply, {
          Ok: (): SessionOpRpcReply => ok(Lifecycle.sessionState(session, this.store.session(session))),
          NotSupported: ({ message }): SessionOpRpcReply => refuse("not_supported", message),
          Failed: ({ message }): SessionOpRpcReply => refuse("internal_error", message),
          NoAnswer: (): SessionOpRpcReply => refuse("internal_error", "The runner didn't answer.")
        })
      }
    })
  }

  // Runner WebSocket

  /** The runner's upgrade, already authenticated by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 400 })
    }
    for (const old of this.ctx.getWebSockets()) old.close(Lifecycle.CLOSE_REPLACED, "replaced")

    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ connectedAt: Date.now() } satisfies Lifecycle.Attachment)
    console.log("runner connected")
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return

    Lifecycle.Frame.match(Lifecycle.classifyFrame(message), {
      Ping: () => ws.send(Runner.HEARTBEAT_PONG),
      RejectHello: () => {
        console.warn("runner hello rejected: unsupported protocol")
        ws.close(Lifecycle.CLOSE_UNSUPPORTED_PROTOCOL, "unsupported_protocol")
      },
      Ignore: () => console.warn(`ignoring runner message: ${message.slice(0, 200)}`),
      Message: ({ message: msg }) => this.onMessage(ws, msg)
    })
  }

  /** Daily cleanup of old turns. */
  override async alarm(): Promise<void> {
    this.run(Lifecycle.Event.cases.Alarm.make({}), (_, now) => Lifecycle.alarm(now))
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

  private onMessage(ws: WebSocket, msg: Runner.RunnerMessage): void {
    const outcome = (result: Lifecycle.Outcome) => {
      console.log(`turn ${result.key} ← ${result.type}`)
      this.run(
        Lifecycle.Event.cases.Outcome.make({ outcome: result }),
        (slice, now) => Lifecycle.outcome(slice, result, now),
        ws
      )
    }
    const sessionOpAnswer = (answer: Runner.SessionOpResult | Runner.SessionOpFailed) => {
      // An answer after the op timed out has no one to tell, and is dropped.
      const waiter = this.opWaiters.get(answer.op_id)
      if (!waiter) return
      const event = { session: waiter.session, opId: answer.op_id, outcome: answer }
      this.run(
        Lifecycle.Event.cases.SessionOpAnswer.make(event),
        (slice, now) => Lifecycle.sessionOpAnswer(slice, event, now),
        ws
      )
    }

    Runner.RunnerMessage.match(msg, {
      hello: (hello) => {
        console.log(
          `runner hello: ${hello.agent.name} (runner ${hello.runner_version}, protocol ${hello.protocol}), ` +
            `in flight: ${hello.in_flight.length}`
        )
        this.run(Lifecycle.Event.cases.Hello.make({ hello }), (slice, now) => Lifecycle.hello(slice, hello, now), ws)
      },
      ack: ({ key }) =>
        this.run(Lifecycle.Event.cases.Ack.make({ key }), (slice, now) => Lifecycle.ack(slice, key, now), ws),
      result: outcome,
      needs_approval: outcome,
      turn_failed: outcome,
      merged: outcome,
      session_op_result: sessionOpAnswer,
      session_op_failed: sessionOpAnswer
    })
  }

  /** Read → step → save → act, all synchronously, so no other event interleaves. */
  private run<A>(
    event: Lifecycle.Event,
    step: (slice: Lifecycle.Slice, now: number) => Lifecycle.Step<A>,
    ws?: WebSocket
  ): A {
    const now = Date.now()
    const { writes, commands, answer } = step(Lifecycle.read(this.store, event), now)
    const pruned = this.store.save(writes)

    for (const row of writes.turns) if (row.state === "unknown") console.log(`turn ${row.key} → unknown`)
    if (pruned > 0) console.log(`pruned ${pruned} old turns`)
    for (const command of commands) this.act(command, ws)

    return answer
  }

  private act(command: Lifecycle.Command, ws: WebSocket | undefined): void {
    Lifecycle.Command.match(command, {
      Send: ({ message }) => {
        if (!ws) throw new Error(`no runner socket to send ${message.type} on`)
        ws.send(encodeMessage(message))
        console.log(
          message.type === "session_op"
            ? `session ${message.session} → runner (${message.op})`
            : `turn ${message.key} → runner${message.type === "steer" ? ` (steer into ${message.into})` : ""}`
        )
      },
      Wake: ({ key }) => {
        for (const wake of [...(this.turnWaiters.get(key) ?? [])]) wake()
      },
      Answer: ({ opId, reply }) => this.opWaiters.get(opId)?.settle(reply),
      Attach: ({ hello }) => {
        if (!ws) throw new Error("no runner socket to attach hello to")
        const attachment = ws.deserializeAttachment() as Lifecycle.Attachment
        ws.serializeAttachment(
          {
            ...attachment,
            hello: { runner_version: hello.runner_version, agent: hello.agent, protocol: hello.protocol }
          } satisfies Lifecycle.Attachment
        )
      },
      SetAlarm: ({ at }) => {
        void this.ctx.storage.setAlarm(at)
      }
    })
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

  /** The runner's answer to session op `opId`, or `NoAnswer` after the timeout. */
  private waitForAnswer(opId: string, session: string): Promise<Lifecycle.SessionOpReply> {
    return new Promise((resolve) => {
      const settle = (reply: Lifecycle.SessionOpReply) => {
        clearTimeout(timer)
        this.opWaiters.delete(opId)
        resolve(reply)
      }
      const timer = setTimeout(
        () => settle(Lifecycle.sessionOpReply(undefined)),
        Duration.toMillis(Lifecycle.SESSION_OP_TIMEOUT)
      )
      this.opWaiters.set(opId, { session, settle })
    })
  }

  /** The connected runner that has said hello, if any, and whether its heartbeat is fresh. */
  private runnerSocket(): { readonly ws: WebSocket; readonly view: Lifecycle.RunnerView } | undefined {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Lifecycle.Attachment | null
      if (ws.readyState !== WebSocket.OPEN || !attachment?.hello) continue
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime()
      return {
        ws,
        view: {
          online: Lifecycle.isOnline(attachment.connectedAt, lastPing, now),
          protocol: attachment.hello.protocol ?? 1
        }
      }
    }
    return undefined
  }

  /** The runner, if it's online, after the check step (which expires old turns while it isn't). */
  private liveRunner(): { readonly ws: WebSocket; readonly runner: Lifecycle.LiveRunner } | undefined {
    const socket = this.runnerSocket()
    const runner = this.run(
      Lifecycle.Event.cases.Check.make({ runner: socket?.view }),
      (slice, now) => Lifecycle.check(slice, socket?.view, now)
    )
    return runner && socket ? { ws: socket.ws, runner } : undefined
  }
}
