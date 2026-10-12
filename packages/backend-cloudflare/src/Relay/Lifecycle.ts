/**
 * The relay's turn and session lifecycle, as a pure reducer. The Relay handles every event in four steps:
 *
 * 1. read: load the rows the event touches ({@link read}),
 * 2. step: `(slice, event, now) → { writes, commands, answer }` (one function per event, {@link step}),
 * 3. save: write `writes` in one transaction,
 * 4. act: run `commands` in order (send on the socket, wake waiters, answer session ops, set the alarm).
 *
 * Save comes before act: if the object dies between them, the socket dies with it, the runner reconnects
 * with `hello`, and the {@link hello} step re-sends what it must.
 *
 * Nothing here touches Cloudflare: timestamps are epoch milliseconds passed in as `now`.
 */
import { Common, Runner, type Status, type Turn } from "@sideband/protocol"
import { Duration, Effect, Exit, Option, Schema, type Types } from "effect"

/** How long `submit` holds the request open before answering `running`. */
export const HOLD = Duration.seconds(25)

/** Poll interval suggested to clients for a `running` turn. */
export const RETRY_AFTER = Duration.seconds(1)

/** A runner whose last `ping` is older than this is offline. */
export const STALE_PING = Duration.seconds(45)

/** After a reconnect, unresolved turns younger than this are re-sent; older ones become `unknown`. */
export const RESEND_WINDOW = Duration.minutes(2)

/** How long a session operation waits for the runner. */
export const SESSION_OP_TIMEOUT = Duration.seconds(25)

/** Resolved turns are deleted this long after their last update. */
export const TURN_RETENTION = Duration.days(7)

/** How often the cleanup alarm runs. */
export const CLEANUP_INTERVAL = Duration.days(1)

/** Close codes from protocol/runner.md. */
export const CLOSE_REPLACED = 4000

export const CLOSE_UNSUPPORTED_PROTOCOL = 4002

export const UNKNOWN_MESSAGE = "Lost contact with the agent. The turn may or may not have run."

// Data

/**
 * `pending` → `sent` → `acked` → `done` (outcome stored) or `unknown` (outcome lost). A turn is stored as
 * `sent` in the step that sends it, so `pending` only appears in rows written before that.
 */
export const TurnStatus = Schema.Literals(["pending", "sent", "acked", "done", "unknown"]).annotate({
  identifier: "TurnStatus"
})

export type TurnStatus = typeof TurnStatus.Type

/** What the runner reported for a turn. */
export const Outcome = Schema.Union([Runner.TurnResult, Runner.TurnNeedsApproval, Runner.TurnFailed, Runner.TurnMerged])
  .annotate({ identifier: "Outcome" })
  .pipe(Schema.toTaggedUnion("type"))

export type Outcome = typeof Outcome.Type

/** A row of `turns`, one per idempotency key. The outcome is stored as JSON in `outcome_json`. */
export const TurnRow = Schema.Struct({
  key: Schema.String,
  session: Schema.String,
  /** SHA-256 of the request payload, to detect a key reused for a different command. */
  payload_hash: Schema.String,
  transcript: Schema.String,
  transcript_raw: Schema.NullOr(Schema.String),
  state: TurnStatus,
  outcome: Schema.NullOr(Schema.fromJsonString(Outcome)),
  /** Key of the turn this one was sent to steer, if it was a steer. */
  steer_into: Schema.NullOr(Schema.String),
  created_at: Schema.Int,
  updated_at: Schema.Int
}).pipe(Schema.encodeKeys({ outcome: "outcome_json" })).annotate({ identifier: "TurnRow" })

export type TurnRow = typeof TurnRow.Type

/** A row of `sessions`, one per session name. */
export const SessionRow = Schema.Struct({
  name: Schema.String,
  agent_session_id: Schema.NullOr(Schema.String),
  /** The turn the session is running. Steers into it don't take this over until it resolves. */
  active_key: Schema.NullOr(Schema.String),
  context_used: Schema.NullOr(Schema.Int),
  context_limit: Schema.NullOr(Schema.Int),
  last_activity: Schema.NullOr(Schema.Int)
}).annotate({ identifier: "SessionRow" })

export type SessionRow = typeof SessionRow.Type

/** Per-socket state, kept with the socket across hibernation. */
export const Attachment = Schema.Struct({
  connectedAt: Schema.Int,
  hello: Schema.optionalKey(Schema.Struct({
    runner_version: Schema.String,
    agent: Common.AgentInfo,
    /** Absent in attachments saved before protocol 2: those runners speak 1. */
    protocol: Schema.optionalKey(Runner.Hello.fields.protocol)
  }))
}).annotate({ identifier: "Attachment" })

export type Attachment = typeof Attachment.Type

/** The runner that has said hello on an open socket, as of its last heartbeat. */
export const RunnerView = Schema.Struct({
  online: Schema.Boolean,
  protocol: Runner.Hello.fields.protocol
}).annotate({ identifier: "RunnerView" })

export type RunnerView = typeof RunnerView.Type

/** The runner, when it's online: what a request may be sent to. */
export const LiveRunner = RunnerView.mapFields(({ protocol }) => ({ protocol })).annotate({ identifier: "LiveRunner" })

export type LiveRunner = typeof LiveRunner.Type

/** A turn handed to the relay by the Worker. */
export const SubmitTurn = Schema.Struct({
  key: Schema.String,
  session: Schema.String,
  transcript: Schema.String,
  transcriptRaw: Schema.optional(Schema.String),
  /** SHA-256 of the request payload, to detect a key reused for a different command. */
  payloadHash: Schema.String
}).annotate({ identifier: "SubmitTurn" })

export type SubmitTurn = typeof SubmitTurn.Type

// Events

/** Everything the relay reacts to. */
export const Event = Schema.TaggedUnion({
  /** Before every RPC: is the runner online, and if not, which turns are lost. */
  Check: { runner: Schema.optional(RunnerView) },
  /** `runner`: the answer of this request's check. */
  Submit: { turn: SubmitTurn, runner: Schema.optional(LiveRunner) },
  Ack: { key: Schema.String },
  Outcome: { outcome: Outcome },
  Hello: { hello: Runner.Hello },
  SessionOp: {
    session: Schema.String,
    op: Runner.SessionOp.fields.op,
    opId: Schema.String,
    runner: Schema.optional(LiveRunner)
  },
  /** The runner's answer to a session op that is still waiting for one. */
  SessionOpAnswer: {
    session: Schema.String,
    opId: Schema.String,
    outcome: Schema.Union([Runner.SessionOpResult, Runner.SessionOpFailed])
  },
  Alarm: {}
}).annotate({ identifier: "Event" })

export type Event = typeof Event.Type

// Step output

/** How a session op ended, for the request waiting on it. */
export const SessionOpReply = Schema.TaggedUnion({
  Ok: {},
  NotSupported: { message: Schema.String },
  Failed: { message: Schema.String },
  /** The runner didn't answer within {@link SESSION_OP_TIMEOUT}. */
  NoAnswer: {}
}).annotate({ identifier: "SessionOpReply" })

export type SessionOpReply = typeof SessionOpReply.Type

/** I/O a step asks for, run in order after its writes are saved. */
export const Command = Schema.TaggedUnion({
  /** Send on the runner's socket. */
  Send: { message: Runner.RelayMessage },
  /** Wake the requests waiting on this turn's outcome. */
  Wake: { key: Schema.String },
  /** Answer the request waiting on this session op. */
  Answer: { opId: Schema.String, reply: SessionOpReply },
  /** Store what the runner's `hello` said with its socket. */
  Attach: { hello: Runner.Hello },
  SetAlarm: { at: Schema.Int }
}).annotate({ identifier: "Command" })

export type Command = typeof Command.Type

/** Rows to upsert (whole rows), and the rest of what a step writes. */
export interface Writes {
  readonly turns: ReadonlyArray<TurnRow>
  readonly sessions: ReadonlyArray<SessionRow>
  /** The agent behind the last runner that said hello, for status while offline. */
  readonly agentName?: string
  /** Delete resolved turns last updated before this. */
  readonly pruneBefore?: number
}

export interface Step<A> {
  readonly writes: Writes
  readonly commands: ReadonlyArray<Command>
  readonly answer: A
}

/** The rows an event touches, as {@link read} loads them. */
export interface Slice {
  readonly turns: ReadonlyArray<TurnRow>
  readonly sessions: ReadonlyArray<SessionRow>
}

export const SubmitAnswer = Schema.TaggedUnion({
  /** The key exists with the same payload: answer with its current state. */
  Replay: { row: TurnRow },
  /** The key exists with a different payload. */
  Conflict: {},
  Offline: {},
  /** A turn is running in the session and the runner can't take a steer. */
  Busy: {},
  /** Sent: wait for the outcome, up to {@link HOLD}. */
  Hold: { key: Schema.String }
}).annotate({ identifier: "SubmitAnswer" })

export type SubmitAnswer = typeof SubmitAnswer.Type

export const SessionOpAnswer = Schema.TaggedUnion({
  Offline: {},
  Busy: {},
  /** Sent: wait for the runner's answer, up to {@link SESSION_OP_TIMEOUT}. */
  Wait: { opId: Schema.String }
}).annotate({ identifier: "SessionOpAnswer" })

export type SessionOpAnswer = typeof SessionOpAnswer.Type

// Refusals

/*
 * How the relay's RPC methods fail. Tagged, so each crosses Durable Object RPC as its own class; the
 * Worker maps them to the protocol's errors, which carry no tag and so can't cross RPC themselves.
 */

/** No runner is online. Nothing was run. */
export class AgentOffline extends Schema.TaggedError<AgentOffline>()("AgentOffline", { message: Schema.String }) {}

/** A turn is running in the session and the runner can't take this request. Nothing was run. */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", { message: Schema.String }) {}

/** The idempotency key was already used for a different command. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()("IdempotencyConflict", {
  message: Schema.String
}) {}

export class TurnNotFound extends Schema.TaggedError<TurnNotFound>()("TurnNotFound", { message: Schema.String }) {}

/** The agent can't do this session op. */
export class OpNotSupported extends Schema.TaggedError<OpNotSupported>()("OpNotSupported", {
  message: Schema.String
}) {}

/** The session op failed at the agent, or the runner didn't answer in time. */
export class OpFailed extends Schema.TaggedError<OpFailed>()("OpFailed", { message: Schema.String }) {}

// Reading

/** The stored rows {@link read} can ask for. */
export interface Source<E, R> {
  readonly turn: (key: string) => Effect.Effect<Option.Option<TurnRow>, E, R>
  readonly session: (name: string) => Effect.Effect<Option.Option<SessionRow>, E, R>
  /** Turns still waiting for an outcome, oldest first. */
  readonly unresolvedTurns: Effect.Effect<ReadonlyArray<TurnRow>, E, R>
  readonly unresolvedSteersInto: (key: string) => Effect.Effect<ReadonlyArray<TurnRow>, E, R>
}

/**
 * Loads the rows `event`'s step reads: the turns it may change, the sessions they belong to, and, for
 * an outcome, the open steers that may take its session over.
 */
export const read = Effect.fnUntraced(
  function*<E, R>(source: Source<E, R>, event: Event): Effect.fn.Return<Slice, E, R> {
    const turns: ReadonlyArray<TurnRow> = yield* Event.match(event, {
      Check: ({ runner }) => runner?.online === true ? Effect.succeed([]) : source.unresolvedTurns,
      Submit: ({ turn }) => source.turn(turn.key).pipe(Effect.map(Option.toArray)),
      Ack: ({ key }) => source.turn(key).pipe(Effect.map(Option.toArray)),
      Outcome: ({ outcome }) =>
        source.turn(outcome.key).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.succeed([]),
            onSome: (row) => source.unresolvedSteersInto(row.key).pipe(Effect.map((steers) => [row, ...steers]))
          }))
        ),
      Hello: () => source.unresolvedTurns,
      SessionOp: () => Effect.succeed([]),
      SessionOpAnswer: () => Effect.succeed([]),
      Alarm: () => Effect.succeed([])
    })

    const named: ReadonlyArray<string> = Event.match(event, {
      Check: () => [],
      Submit: ({ turn }) => [turn.session],
      Ack: () => [],
      Outcome: () => [],
      Hello: () => [],
      SessionOp: ({ session }) => [session],
      SessionOpAnswer: ({ session }) => [session],
      Alarm: () => []
    })

    const names = new Set([...named, ...turns.map((row) => row.session)])
    const sessions = yield* Effect.forEach(names, source.session)

    return { turns, sessions: sessions.flatMap(Option.toArray) }
  }
)

// Stepping

export const isResolved = (row: TurnRow): boolean => row.state === "done" || row.state === "unknown"

/** The rows of a slice as a step changes them, and what it has written and asked for so far. */
class Draft {
  private readonly turns: Map<string, TurnRow>
  private readonly sessions: Map<string, SessionRow>
  private readonly changedTurns = new Set<string>()
  private readonly changedSessions = new Set<string>()
  private agentName: string | undefined
  private pruneBefore: number | undefined
  readonly commands: Array<Command> = []

  constructor(slice: Slice) {
    this.turns = new Map(slice.turns.map((row) => [row.key, row]))
    this.sessions = new Map(slice.sessions.map((row) => [row.name, row]))
  }

  turn(key: string): TurnRow | undefined {
    return this.turns.get(key)
  }

  session(name: string): SessionRow | undefined {
    return this.sessions.get(name)
  }

  /** Unresolved turns, oldest first. */
  unresolved(): ReadonlyArray<TurnRow> {
    return [...this.turns.values()].filter((row) => !isResolved(row)).toSorted((a, b) => a.created_at - b.created_at)
  }

  putTurn(row: TurnRow): void {
    this.turns.set(row.key, row)
    this.changedTurns.add(row.key)
  }

  putSession(row: SessionRow): void {
    this.sessions.set(row.name, row)
    this.changedSessions.add(row.name)
  }

  setAgentName(name: string): void {
    this.agentName = name
  }

  prune(before: number): void {
    this.pruneBefore = before
  }

  done<A>(answer: A): Step<A> {
    const writes: Types.Mutable<Writes> = {
      turns: [...this.changedTurns].flatMap((key) => this.turns.get(key) ?? []),
      sessions: [...this.changedSessions].flatMap((name) => this.sessions.get(name) ?? [])
    }

    if (this.agentName !== undefined) writes.agentName = this.agentName

    if (this.pruneBefore !== undefined) writes.pruneBefore = this.pruneBefore

    return { writes, commands: this.commands, answer }
  }
}

const emptySession = (name: string): SessionRow => ({
  name,
  agent_session_id: null,
  active_key: null,
  context_used: null,
  context_limit: null,
  last_activity: null
})

/**
 * `session` once `agentSessionId` is behind it. Keeps the last context usage when none is reported, unless
 * the agent session changed.
 */
export const agentSessionAfter = (
  session: SessionRow,
  agentSessionId: string,
  context: Common.ContextUsage | undefined,
  now: number
): SessionRow => {
  const keep = context === undefined && session.agent_session_id === agentSessionId

  return {
    ...session,
    agent_session_id: agentSessionId,
    context_used: keep ? session.context_used : context?.used_tokens ?? null,
    context_limit: keep ? session.context_limit : context?.limit_tokens ?? null,
    last_activity: now
  }
}

/**
 * Stores `key`'s outcome (`undefined`: lost) and wakes its waiters. If it was its session's active turn,
 * the latest unresolved steer into it takes over (the runner may still run that steer on its own);
 * otherwise the session is free for the next turn.
 */
const resolveIn = (draft: Draft, key: string, outcome: Outcome | undefined, now: number): void => {
  const row = draft.turn(key)

  if (row === undefined) return

  draft.putTurn({ ...row, state: outcome ? "done" : "unknown", outcome: outcome ?? null, updated_at: now })
  const session = draft.session(row.session)

  if (session?.active_key === key) {
    const next = draft.unresolved().filter((turn) => turn.steer_into === key).at(-1)
    draft.putSession({ ...session, active_key: next?.key ?? null, last_activity: now })
  }

  if (outcome && Outcome.isAnyOf(["result", "needs_approval"])(outcome)) {
    draft.putSession(agentSessionAfter(
      draft.session(row.session) ?? emptySession(row.session),
      outcome.agent_session_id,
      outcome.type === "result" ? outcome.context : undefined,
      now
    ))
  }

  draft.commands.push(Command.cases.Wake.make({ key }))
}

/** {@link resolveIn} on its own: one turn's outcome, applied to `slice`. */
export const resolve = (slice: Slice, key: string, outcome: Outcome | undefined, now: number): Step<undefined> => {
  const draft = new Draft(slice)
  resolveIn(draft, key, outcome, now)

  return draft.done(undefined)
}

/** Marks every unresolved turn older than the re-send window `unknown`. */
const expireStale = (draft: Draft, now: number): void => {
  for (const row of draft.unresolved()) {
    if (now - row.created_at >= Duration.toMillis(RESEND_WINDOW)) resolveIn(draft, row.key, undefined, now)
  }
}

/** Whether a runner is online: its last heartbeat (or, before the first, its connection) is fresh. */
export const isOnline = (connectedAt: number, lastPing: number | undefined, now: number): boolean =>
  now - (lastPing ?? connectedAt) <= Duration.toMillis(STALE_PING)

/**
 * Before every RPC. If the runner is offline, nothing will resolve old turns until it comes back, so turns
 * past the re-send window become `unknown` now (pollers stop waiting). Answers the runner if it's online.
 */
export const check = (slice: Slice, runner: RunnerView | undefined, now: number): Step<LiveRunner | undefined> => {
  const draft = new Draft(slice)

  if (runner?.online) return draft.done({ protocol: runner.protocol })
  expireStale(draft, now)

  return draft.done(undefined)
}

/** The runner message for a turn, continuing its session's agent session if it has one. */
export const turnMessage = (row: TurnRow, agentSessionId: string | null | undefined): Runner.RelayMessage => {
  const message: Types.Mutable<Runner.Turn> = {
    type: "turn",
    key: row.key,
    session: row.session,
    transcript: row.transcript
  }

  if (agentSessionId) message.agent_session_id = agentSessionId

  return message
}

/** The runner message for a steer of `row` into the running turn `into`. */
export const steerMessage = (
  row: TurnRow,
  into: string,
  agentSessionId: string | null | undefined
): Runner.RelayMessage => {
  const message: Types.Mutable<Runner.Steer> = {
    type: "steer",
    key: row.key,
    into,
    session: row.session,
    transcript: row.transcript
  }

  if (agentSessionId) message.agent_session_id = agentSessionId

  return message
}

/** The runner message for a session op, on the session's agent session if it has one. */
export const sessionOpMessage = (
  opId: string,
  op: Runner.SessionOp["op"],
  session: string,
  agentSessionId: string | null | undefined
): Runner.RelayMessage => {
  const message: Types.Mutable<Runner.SessionOp> = { type: "session_op", op_id: opId, op, session }

  if (agentSessionId) message.agent_session_id = agentSessionId

  return message
}

/**
 * A new turn. A replayed key answers with its stored state, even while offline. A session that is
 * running a turn takes the new one as a steer into it (protocol 2) or refuses it (protocol 1).
 */
export const submit = (
  slice: Slice,
  turn: SubmitTurn,
  runner: LiveRunner | undefined,
  now: number
): Step<SubmitAnswer> => {
  const draft = new Draft(slice)
  const existing = draft.turn(turn.key)

  if (existing) {
    return draft.done(
      existing.payload_hash === turn.payloadHash
        ? SubmitAnswer.cases.Replay.make({ row: existing })
        : SubmitAnswer.cases.Conflict.make({})
    )
  }

  if (!runner) return draft.done(SubmitAnswer.cases.Offline.make({}))
  const session = draft.session(turn.session)
  const active = session?.active_key ?? null

  if (active !== null && runner.protocol < 2) return draft.done(SubmitAnswer.cases.Busy.make({}))

  const row: TurnRow = {
    key: turn.key,
    session: turn.session,
    payload_hash: turn.payloadHash,
    transcript: turn.transcript,
    transcript_raw: turn.transcriptRaw ?? null,
    state: "sent",
    outcome: null,
    steer_into: active,
    created_at: now,
    updated_at: now
  }

  draft.putTurn(row)

  // A steer leaves the active turn alone: it's answered through that turn.
  if (active !== null && session) {
    draft.putSession({ ...session, last_activity: now })
    draft.commands.push(Command.cases.Send.make({ message: steerMessage(row, active, session.agent_session_id) }))
  } else {
    draft.putSession({ ...session ?? emptySession(turn.session), active_key: turn.key, last_activity: now })
    draft.commands.push(Command.cases.Send.make({ message: turnMessage(row, session?.agent_session_id) }))
  }

  return draft.done(SubmitAnswer.cases.Hold.make({ key: turn.key }))
}

/** The runner received a turn. Only a turn still waiting to be received moves. */
export const ack = (slice: Slice, key: string, now: number): Step<undefined> => {
  const draft = new Draft(slice)
  const row = draft.turn(key)

  if (row && (row.state === "pending" || row.state === "sent")) {
    draft.putTurn({ ...row, state: "acked", updated_at: now })
  }

  return draft.done(undefined)
}

/** A turn's outcome. Duplicates (e.g. re-delivered after a reconnect) are ignored. */
export const outcome = (slice: Slice, result: Outcome, now: number): Step<undefined> => {
  const draft = new Draft(slice)
  const row = draft.turn(result.key)

  if (row && !isResolved(row)) resolveIn(draft, row.key, result, now)

  return draft.done(undefined)
}

/**
 * First message of a connection. Turns the runner is still executing are left alone; other unresolved
 * turns are re-sent if recent (the runner never runs a key twice) or marked `unknown`, so a command never
 * runs late by surprise. Steers are never re-sent: the agent can't dedup them.
 */
export const hello = (slice: Slice, message: Runner.Hello, now: number): Step<undefined> => {
  const draft = new Draft(slice)
  draft.commands.push(Command.cases.Attach.make({ hello: message }))
  draft.setAgentName(message.agent.name)
  const inFlight = new Set(message.in_flight)

  for (const row of draft.unresolved()) {
    if (inFlight.has(row.key)) continue

    if (row.steer_into === null && now - row.created_at < Duration.toMillis(RESEND_WINDOW)) {
      draft.putTurn({ ...row, state: "sent", updated_at: now })
      draft.commands.push(
        Command.cases.Send.make({ message: turnMessage(row, draft.session(row.session)?.agent_session_id) })
      )
    } else {
      resolveIn(draft, row.key, undefined, now)
    }
  }

  return draft.done(undefined)
}

/** Starts `new` or `compact` on a session that isn't running a turn. */
export const sessionOp = (
  slice: Slice,
  op: { readonly session: string; readonly op: Runner.SessionOp["op"]; readonly opId: string },
  runner: LiveRunner | undefined
): Step<SessionOpAnswer> => {
  const draft = new Draft(slice)

  if (!runner) return draft.done(SessionOpAnswer.cases.Offline.make({}))
  const session = draft.session(op.session)

  if (session?.active_key != null) return draft.done(SessionOpAnswer.cases.Busy.make({}))

  draft.commands.push(Command.cases.Send.make({
    message: sessionOpMessage(op.opId, op.op, op.session, session?.agent_session_id)
  }))

  return draft.done(SessionOpAnswer.cases.Wait.make({ opId: op.opId }))
}

/** How a session op ended (`undefined`: the runner didn't answer). */
export const sessionOpReply = (
  result: Runner.SessionOpResult | Runner.SessionOpFailed | undefined
): SessionOpReply => {
  if (result === undefined) return SessionOpReply.cases.NoAnswer.make({})

  if (result.type === "session_op_result") return SessionOpReply.cases.Ok.make({})

  return result.code === "not_supported"
    ? SessionOpReply.cases.NotSupported.make({ message: result.message })
    : SessionOpReply.cases.Failed.make({ message: result.message })
}

/** The runner answered a waiting session op: a success moves the session to the agent session it names. */
export const sessionOpAnswer = (
  slice: Slice,
  answer: {
    readonly session: string
    readonly opId: string
    readonly outcome: Runner.SessionOpResult | Runner.SessionOpFailed
  },
  now: number
): Step<undefined> => {
  const draft = new Draft(slice)

  if (answer.outcome.type === "session_op_result") {
    draft.putSession(agentSessionAfter(
      draft.session(answer.session) ?? emptySession(answer.session),
      answer.outcome.agent_session_id,
      answer.outcome.context,
      now
    ))
  }

  draft.commands.push(Command.cases.Answer.make({ opId: answer.opId, reply: sessionOpReply(answer.outcome) }))

  return draft.done(undefined)
}

/** Daily cleanup: prune old resolved turns, and run again in a day. */
export const alarm = (now: number): Step<undefined> => {
  const draft = new Draft({ turns: [], sessions: [] })
  draft.prune(now - Duration.toMillis(TURN_RETENTION))
  draft.commands.push(Command.cases.SetAlarm.make({ at: now + Duration.toMillis(CLEANUP_INTERVAL) }))

  return draft.done(undefined)
}

type Answer = LiveRunner | SubmitAnswer | SessionOpAnswer | undefined

/** The step for any event. */
export const step = (slice: Slice, event: Event, now: number): Step<Answer> =>
  Event.match(event, {
    Check: ({ runner }): Step<Answer> => check(slice, runner, now),
    Submit: ({ turn, runner }): Step<Answer> => submit(slice, turn, runner, now),
    Ack: ({ key }): Step<Answer> => ack(slice, key, now),
    Outcome: (e): Step<Answer> => outcome(slice, e.outcome, now),
    Hello: (e): Step<Answer> => hello(slice, e.hello, now),
    SessionOp: (e): Step<Answer> => sessionOp(slice, e, e.runner),
    SessionOpAnswer: (e): Step<Answer> => sessionOpAnswer(slice, e, now),
    Alarm: (): Step<Answer> => alarm(now)
  })

// Answers

/** A runner frame: the heartbeat, a message, or one to reject or ignore. */
export const Frame = Schema.TaggedUnion({
  Ping: {},
  Message: { message: Runner.RunnerMessage },
  /** A `hello` we can't decode: the runner speaks a protocol this relay doesn't. */
  RejectHello: {},
  Ignore: {}
}).annotate({ identifier: "Frame" })

export type Frame = typeof Frame.Type

const decodeMessage = Schema.decodeUnknownExit(Schema.fromJsonString(Runner.RunnerMessage))

const isHello = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("hello") })))

export const classifyFrame = (text: string): Frame => {
  if (text === Runner.HEARTBEAT_PING) return Frame.cases.Ping.make({})
  const decoded = decodeMessage(text)

  if (Exit.isSuccess(decoded)) return Frame.cases.Message.make({ message: decoded.value })

  return Option.isSome(isHello(text)) ? Frame.cases.RejectHello.make({}) : Frame.cases.Ignore.make({})
}

/** A turn's state as clients see it. The runner's agent session never leaves the relay. */
export const turnState = (row: TurnRow): typeof Turn.TurnState.Encoded => {
  const base = { idempotency_key: row.key, session: row.session, transcript: row.transcript }

  if (row.state === "unknown") return { status: "unknown", ...base, message: UNKNOWN_MESSAGE }

  if (row.state !== "done" || row.outcome === null) {
    return { status: "running", ...base, retry_after_ms: Duration.toMillis(RETRY_AFTER) }
  }

  return Outcome.match(row.outcome, {
    result: (
      { type: _type, key: _key, agent_session_id: _agentSessionId, ...answer }
    ): typeof Turn.TurnState.Encoded => {
      const state: Types.Mutable<typeof Turn.TurnCompleted.Encoded> = { status: "completed", ...base, ...answer }

      if (row.transcript_raw !== null) state.transcript_raw = row.transcript_raw

      return state
    },
    needs_approval: ({ message }): typeof Turn.TurnState.Encoded => ({ status: "needs_approval", ...base, message }),
    turn_failed: ({ code, message }): typeof Turn.TurnState.Encoded => ({ status: "failed", ...base, code, message }),
    merged: ({ into }): typeof Turn.TurnState.Encoded => ({ status: "merged", ...base, into })
  })
}

/** A session's state as clients see it. */
export const sessionState = (name: string, row: SessionRow | undefined): typeof Status.SessionState.Encoded => {
  const state: Types.Mutable<typeof Status.SessionState.Encoded> = { name, busy: row?.active_key != null }

  if (row?.context_used != null && row.context_limit != null) {
    state.context = { used_tokens: row.context_used, limit_tokens: row.context_limit }
  }

  if (row?.last_activity != null) state.last_activity = new Date(row.last_activity).toISOString()

  return state
}

/** `GET /v1/status`. */
export const status = (
  agentName: string | undefined,
  online: boolean,
  session: typeof Status.SessionState.Encoded
): typeof Status.Status.Encoded => {
  const agent: Types.Mutable<(typeof Status.Status.Encoded)["agent"]> = { online }

  if (agentName !== undefined) agent.name = agentName

  return { agent, session }
}
