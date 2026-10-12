/**
 * The relay's turn and session lifecycle, as a pure reducer. The Relay handles every event in four steps:
 *
 * 1. read: load the rows the event touches ({@link read}),
 * 2. step: `(slice, event, now) → { writes, commands, answer }` (one function per event, {@link step}),
 * 3. save: write `writes` in one transaction,
 * 4. act: run `commands` in order (send on the socket, settle waiting requests, answer session ops, set the
 *    alarm).
 *
 * Save comes before act: if the object dies between them, the socket dies with it, the runner reconnects
 * with `hello`, and the {@link hello} step re-sends what it must.
 *
 * A state the relay's own writes never produce (a turn without its session, an outcome for a turn the step
 * didn't load) is a bug, not a case: the step throws, which fails the event as a defect.
 *
 * Nothing here touches Cloudflare: timestamps are epoch milliseconds passed in as `now`.
 */
import { Common, Runner, type Status, type Turn } from "@sideband/protocol"
import { Duration, Effect, Exit, Option, Result, Schema } from "effect"

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

/** An instant, as milliseconds since the Unix epoch. */
export const EpochMillis = Schema.Int.pipe(Schema.brand("EpochMillis"))

export type EpochMillis = typeof EpochMillis.Type

/** `instant` plus `duration`. */
export const after = (instant: EpochMillis, duration: Duration.Duration): EpochMillis =>
  EpochMillis.make(instant + Duration.toMillis(duration))

/** What the runner reported for a turn. */
export const Outcome = Schema.Union([Runner.TurnResult, Runner.TurnNeedsApproval, Runner.TurnFailed, Runner.TurnMerged])
  .annotate({ identifier: "Outcome" })
  .pipe(Schema.toTaggedUnion("type"))

export type Outcome = typeof Outcome.Type

const turnFields = {
  key: Common.IdempotencyKey,
  session: Common.SessionName,
  /** SHA-256 of the request payload, to detect a key reused for a different command. */
  payload_hash: Schema.String,
  transcript: Schema.String,
  transcript_raw: Schema.NullOr(Schema.String),
  /** Key of the turn this one was sent to steer, if it was a steer. */
  steer_into: Schema.NullOr(Common.IdempotencyKey),
  created_at: EpochMillis,
  updated_at: EpochMillis
}

/** A turn waiting for its outcome: `sent` to the runner, then `acked` once the runner has it. */
export const OpenTurnRow = Schema.Struct({
  ...turnFields,
  state: Schema.Literals(["sent", "acked"]),
  outcome: Schema.Null
}).pipe(Schema.encodeKeys({ outcome: "outcome_json" })).annotate({ identifier: "OpenTurnRow" })

/** A turn with its outcome. Final. */
export const DoneTurnRow = Schema.Struct({
  ...turnFields,
  state: Schema.Literal("done"),
  outcome: Schema.fromJsonString(Outcome)
}).pipe(Schema.encodeKeys({ outcome: "outcome_json" })).annotate({ identifier: "DoneTurnRow" })

/** A turn whose outcome was lost: it may or may not have run. Final. */
export const UnknownTurnRow = Schema.Struct({
  ...turnFields,
  state: Schema.Literal("unknown"),
  outcome: Schema.Null
}).pipe(Schema.encodeKeys({ outcome: "outcome_json" })).annotate({ identifier: "UnknownTurnRow" })

/** A row of `turns`, one per idempotency key. Only a `done` turn has an outcome (`outcome_json`). */
export const TurnRow = Schema.Union([OpenTurnRow, DoneTurnRow, UnknownTurnRow]).annotate({ identifier: "TurnRow" })

export type TurnRow = typeof TurnRow.Type

export type OpenTurnRow = typeof OpenTurnRow.Type

/** A row of `sessions`, one per session name. */
export const SessionRow = Schema.Struct({
  name: Common.SessionName,
  agent_session_id: Schema.NullOr(Common.AgentSessionId),
  /** The turn the session is running. Steers into it don't take this over until it resolves. */
  active_key: Schema.NullOr(Common.IdempotencyKey),
  /** Context usage of the agent session, as last reported. */
  context: Schema.NullOr(Schema.fromJsonString(Common.ContextUsage)),
  last_activity: Schema.NullOr(EpochMillis)
}).pipe(Schema.encodeKeys({ context: "context_json" })).annotate({ identifier: "SessionRow" })

export type SessionRow = typeof SessionRow.Type

/** Per-socket state, kept with the socket across hibernation. */
export const Attachment = Schema.Struct({
  connectedAt: EpochMillis,
  hello: Schema.optionalKey(Schema.Struct({
    runner_version: Schema.String,
    agent: Common.AgentInfo,
    protocol: Runner.Hello.fields.protocol
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
  key: Common.IdempotencyKey,
  session: Common.SessionName,
  transcript: Schema.String,
  transcriptRaw: Schema.optional(Schema.String),
  /** SHA-256 of the request payload, to detect a key reused for a different command. */
  payloadHash: Schema.String
}).annotate({ identifier: "SubmitTurn" })

export type SubmitTurn = typeof SubmitTurn.Type

/** The runner's answer to a session op. */
export const SessionOpOutcome = Schema.Union([Runner.SessionOpResult, Runner.SessionOpFailed]).annotate({
  identifier: "SessionOpOutcome"
})

export type SessionOpOutcome = typeof SessionOpOutcome.Type

// Events

/** Everything the relay reacts to. */
export const Event = Schema.TaggedUnion({
  /** Before every RPC: is the runner online, and if not, which turns are lost. */
  Check: { runner: Schema.optional(RunnerView) },
  /** `runner`: the answer of this request's check. */
  Submit: { turn: SubmitTurn, runner: Schema.optional(LiveRunner) },
  Ack: { key: Common.IdempotencyKey },
  Outcome: { outcome: Outcome },
  Hello: { hello: Runner.Hello },
  SessionOp: {
    session: Common.SessionName,
    op: Runner.SessionOp.fields.op,
    opId: Runner.OpId,
    runner: Schema.optional(LiveRunner)
  },
  /** The runner's answer to a session op that is still waiting for one. */
  SessionOpAnswer: { session: Common.SessionName, opId: Runner.OpId, outcome: SessionOpOutcome },
  Alarm: {}
}).annotate({ identifier: "Event" })

export type Event = typeof Event.Type

// Refusals

/*
 * How the relay refuses a request. The steps answer with these, and the Relay's RPC methods fail with
 * them: tagged, so each crosses Durable Object RPC as its own class. The Worker maps them to the protocol's
 * errors, which carry no tag and so can't cross RPC themselves.
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

/**
 * The relay's storage failed. The event's writes roll back and its commands never run, so nothing was sent or
 * answered on its account.
 */
export class StorageFailed extends Schema.TaggedError<StorageFailed>()("StorageFailed", {
  message: Schema.String
}) {}

const offline = () => new AgentOffline({ message: "The agent is offline. Nothing was run." })

// Step output

/** I/O a step asks for, run in order after its writes are saved. */
export const Command = Schema.TaggedUnion({
  /** Send on the runner's socket. */
  Send: { message: Runner.RelayMessage },
  /** The turn resolved: the requests holding for its outcome answer now. */
  TurnSettled: { key: Common.IdempotencyKey },
  /** The runner answered this session op: the request waiting on it answers now. */
  Answer: { opId: Runner.OpId, outcome: SessionOpOutcome },
  /** Store what the runner's `hello` said with its socket. */
  Attach: { hello: Runner.Hello },
  SetAlarm: { at: EpochMillis }
}).annotate({ identifier: "Command" })

export type Command = typeof Command.Type

/** Rows to upsert (whole rows), and the rest of what a step writes. */
export interface Writes {
  readonly turns: ReadonlyArray<TurnRow>
  readonly sessions: ReadonlyArray<SessionRow>
  /** The agent behind the last runner that said hello, for status while offline. */
  readonly agentName?: string
  /** Delete resolved turns last updated before this. */
  readonly pruneBefore?: EpochMillis
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

/** A submit the relay accepted. */
export const Accepted = Schema.TaggedUnion({
  /** The key exists with the same payload: answer with its current state. */
  Replay: { row: TurnRow },
  /** Sent: wait for the outcome, up to {@link HOLD}. */
  Hold: { key: Common.IdempotencyKey }
}).annotate({ identifier: "Accepted" })

export type Accepted = typeof Accepted.Type

export type SubmitAnswer = Result.Result<Accepted, AgentOffline | SessionBusy | IdempotencyConflict>

/** Success: sent, wait for the runner's answer, up to {@link SESSION_OP_TIMEOUT}. */
export type SessionOpAnswer = Result.Result<void, AgentOffline | SessionBusy>

// Reading

/** The stored rows {@link read} can ask for. */
export interface Source<E, R> {
  readonly turn: (key: Common.IdempotencyKey) => Effect.Effect<Option.Option<TurnRow>, E, R>
  readonly session: (name: Common.SessionName) => Effect.Effect<Option.Option<SessionRow>, E, R>
  /** Turns still waiting for an outcome, oldest first. */
  readonly openTurns: Effect.Effect<ReadonlyArray<OpenTurnRow>, E, R>
  readonly openSteersInto: (key: Common.IdempotencyKey) => Effect.Effect<ReadonlyArray<OpenTurnRow>, E, R>
}

/**
 * Loads the rows `event`'s step reads: the turns it may change, the sessions they belong to, and, for an
 * outcome, the open steers that may take its session over.
 */
export const read = Effect.fn("Lifecycle.read")(
  function*<E, R>(source: Source<E, R>, event: Event): Effect.fn.Return<Slice, E, R> {
    type Turns = Effect.Effect<ReadonlyArray<TurnRow>, E, R>

    const none: Turns = Effect.succeed([])

    const turns = yield* Event.match(event, {
      Check: ({ runner }): Turns => runner?.online === true ? none : source.openTurns,
      Submit: ({ turn }): Turns => source.turn(turn.key).pipe(Effect.map(Option.toArray)),
      Ack: ({ key }): Turns => source.turn(key).pipe(Effect.map(Option.toArray)),
      Outcome: ({ outcome }): Turns =>
        source.turn(outcome.key).pipe(
          Effect.flatMap(Option.match({
            onNone: () => none,
            onSome: (row) => source.openSteersInto(row.key).pipe(Effect.map((steers) => [row, ...steers]))
          }))
        ),
      Hello: (): Turns => source.openTurns,
      SessionOp: (): Turns => none,
      SessionOpAnswer: (): Turns => none,
      Alarm: (): Turns => none
    })

    const named: ReadonlyArray<Common.SessionName> = Event.match(event, {
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

/** A state the relay's own writes never produce. Thrown, so the event fails as a defect. */
const impossible = (what: string): never => {
  throw new Error(`relay invariant broken: ${what}`)
}

export const isOpen = (row: TurnRow): row is OpenTurnRow => row.state === "sent" || row.state === "acked"

/** The rows of a slice as a step changes them, and what it has written and asked for so far. */
class Draft {
  private readonly turns: Map<Common.IdempotencyKey, TurnRow>
  private readonly sessions: Map<Common.SessionName, SessionRow>
  private readonly changedTurns = new Set<Common.IdempotencyKey>()
  private readonly changedSessions = new Set<Common.SessionName>()
  private agentName: string | undefined
  private pruneBefore: EpochMillis | undefined
  readonly commands: Array<Command> = []

  constructor(slice: Slice) {
    this.turns = new Map(slice.turns.map((row) => [row.key, row]))
    this.sessions = new Map(slice.sessions.map((row) => [row.name, row]))
  }

  turn(key: Common.IdempotencyKey): TurnRow | undefined {
    return this.turns.get(key)
  }

  session(name: Common.SessionName): SessionRow | undefined {
    return this.sessions.get(name)
  }

  /** The session of a loaded turn, which {@link read} always loads with it. */
  sessionOf(row: TurnRow): SessionRow {
    return this.sessions.get(row.session) ?? impossible(`turn ${row.key} without its session ${row.session}`)
  }

  /** Turns waiting for their outcome, oldest first. */
  open(): ReadonlyArray<OpenTurnRow> {
    return [...this.turns.values()].filter(isOpen).toSorted((a, b) => a.created_at - b.created_at)
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

  prune(before: EpochMillis): void {
    this.pruneBefore = before
  }

  done<A>(answer: A): Step<A> {
    const turns = [...this.changedTurns].flatMap((key) => this.turns.get(key) ?? [])
    const sessions = [...this.changedSessions].flatMap((name) => this.sessions.get(name) ?? [])
    const named = this.agentName === undefined ? { turns, sessions } : { turns, sessions, agentName: this.agentName }
    const writes = this.pruneBefore === undefined ? named : { ...named, pruneBefore: this.pruneBefore }

    return { writes, commands: this.commands, answer }
  }
}

const emptySession = (name: Common.SessionName): SessionRow => ({
  name,
  agent_session_id: null,
  active_key: null,
  context: null,
  last_activity: null
})

/**
 * `session` once `agentSessionId` is behind it. Keeps the last context usage when none is reported, unless
 * the agent session changed.
 */
export const agentSessionAfter = (
  session: SessionRow,
  agentSessionId: Common.AgentSessionId,
  context: Common.ContextUsage | undefined,
  now: EpochMillis
): SessionRow => {
  const keep = context === undefined && session.agent_session_id === agentSessionId

  return {
    ...session,
    agent_session_id: agentSessionId,
    context: keep ? session.context : context ?? null,
    last_activity: now
  }
}

/**
 * Stores the outcome of the open turn `row` (`undefined`: lost) and settles its waiters. If it was its
 * session's active turn, the latest open steer into it takes over (the runner may still run that steer on
 * its own); otherwise the session is free for the next turn.
 */
const resolveIn = (draft: Draft, row: OpenTurnRow, outcome: Outcome | undefined, now: EpochMillis): void => {
  draft.putTurn(
    outcome === undefined
      ? { ...row, state: "unknown", outcome: null, updated_at: now }
      : { ...row, state: "done", outcome, updated_at: now }
  )

  const session = draft.sessionOf(row)

  if (session.active_key === row.key) {
    const next = draft.open().filter((turn) => turn.steer_into === row.key).at(-1)
    draft.putSession({ ...session, active_key: next?.key ?? null, last_activity: now })
  }

  if (outcome && Outcome.isAnyOf(["result", "needs_approval"])(outcome)) {
    draft.putSession(agentSessionAfter(
      draft.sessionOf(row),
      outcome.agent_session_id,
      outcome.type === "result" ? outcome.context : undefined,
      now
    ))
  }

  draft.commands.push(Command.cases.TurnSettled.make({ key: row.key }))
}

/** {@link resolveIn} on its own: the outcome of open turn `key`, applied to `slice`. */
export const resolve = (
  slice: Slice,
  key: Common.IdempotencyKey,
  outcome: Outcome | undefined,
  now: EpochMillis
): Step<undefined> => {
  const draft = new Draft(slice)
  const row = draft.turn(key)

  resolveIn(
    draft,
    row !== undefined && isOpen(row) ? row : impossible(`resolving ${key}, not an open turn`),
    outcome,
    now
  )

  return draft.done(undefined)
}

/** Marks every open turn older than the re-send window `unknown`. */
const expireStale = (draft: Draft, now: EpochMillis): void => {
  for (const row of draft.open()) {
    if (now - row.created_at >= Duration.toMillis(RESEND_WINDOW)) resolveIn(draft, row, undefined, now)
  }
}

/** Whether a runner is online: its last heartbeat (or, before the first, its connection) is fresh. */
export const isOnline = (connectedAt: EpochMillis, lastPing: number | undefined, now: EpochMillis): boolean =>
  now - (lastPing ?? connectedAt) <= Duration.toMillis(STALE_PING)

/**
 * Before every RPC. If the runner is offline, nothing will resolve old turns until it comes back, so turns
 * past the re-send window become `unknown` now (pollers stop waiting). Answers the runner if it's online.
 */
export const check = (
  slice: Slice,
  runner: RunnerView | undefined,
  now: EpochMillis
): Step<LiveRunner | undefined> => {
  const draft = new Draft(slice)

  if (runner?.online) return draft.done({ protocol: runner.protocol })
  expireStale(draft, now)

  return draft.done(undefined)
}

/** The runner message for a turn, continuing `agentSessionId` if the session has one. */
export const turnMessage = (row: TurnRow, agentSessionId: Common.AgentSessionId | null): Runner.Turn => {
  const message = { type: "turn", key: row.key, session: row.session, transcript: row.transcript } as const

  return agentSessionId === null ? message : { ...message, agent_session_id: agentSessionId }
}

/** The runner message for a steer of `row` into the running turn `into`. */
export const steerMessage = (
  row: TurnRow,
  into: Common.IdempotencyKey,
  agentSessionId: Common.AgentSessionId | null
): Runner.Steer => {
  const message = { type: "steer", key: row.key, into, session: row.session, transcript: row.transcript } as const

  return agentSessionId === null ? message : { ...message, agent_session_id: agentSessionId }
}

/** The runner message for a session op, on the session's agent session if it has one. */
export const sessionOpMessage = (
  opId: Runner.OpId,
  op: Runner.SessionOp["op"],
  session: SessionRow
): Runner.SessionOp => {
  const message = { type: "session_op", op_id: opId, op, session: session.name } as const

  return session.agent_session_id === null ? message : { ...message, agent_session_id: session.agent_session_id }
}

/**
 * A new turn. A replayed key answers with its stored state, even while offline. A session that is running a
 * turn takes the new one as a steer into it (protocol 2) or refuses it (protocol 1).
 */
export const submit = (
  slice: Slice,
  turn: SubmitTurn,
  runner: LiveRunner | undefined,
  now: EpochMillis
): Step<SubmitAnswer> => {
  const draft = new Draft(slice)
  const existing = draft.turn(turn.key)

  if (existing) {
    return draft.done(
      existing.payload_hash === turn.payloadHash
        ? Result.succeed(Accepted.cases.Replay.make({ row: existing }))
        : Result.fail(
          new IdempotencyConflict({ message: "This Idempotency-Key was already used for a different command." })
        )
    )
  }

  if (!runner) return draft.done(Result.fail(offline()))
  const session = draft.session(turn.session) ?? emptySession(turn.session)

  const row: OpenTurnRow = {
    key: turn.key,
    session: turn.session,
    payload_hash: turn.payloadHash,
    transcript: turn.transcript,
    transcript_raw: turn.transcriptRaw ?? null,
    state: "sent",
    outcome: null,
    steer_into: session.active_key,
    created_at: now,
    updated_at: now
  }

  if (session.active_key === null) {
    draft.putTurn(row)
    draft.putSession({ ...session, active_key: turn.key, last_activity: now })
    draft.commands.push(Command.cases.Send.make({ message: turnMessage(row, session.agent_session_id) }))
  } else if (runner.protocol < 2) {
    return draft.done(
      Result.fail(
        new SessionBusy({ message: "The agent is still working on the previous command. Nothing was run." })
      )
    )
  } else {
    // A steer leaves the active turn alone: it's answered through that turn.
    draft.putTurn(row)
    draft.putSession({ ...session, last_activity: now })
    draft.commands.push(Command.cases.Send.make({
      message: steerMessage(row, session.active_key, session.agent_session_id)
    }))
  }

  return draft.done(Result.succeed(Accepted.cases.Hold.make({ key: turn.key })))
}

/** The runner received a turn. Only a `sent` turn moves. */
export const ack = (slice: Slice, key: Common.IdempotencyKey, now: EpochMillis): Step<undefined> => {
  const draft = new Draft(slice)
  const row = draft.turn(key)

  if (row?.state === "sent") draft.putTurn({ ...row, state: "acked", updated_at: now })

  return draft.done(undefined)
}

/** A turn's outcome. Duplicates (e.g. re-delivered after a reconnect) and pruned keys are ignored. */
export const outcome = (slice: Slice, result: Outcome, now: EpochMillis): Step<undefined> => {
  const draft = new Draft(slice)
  const row = draft.turn(result.key)

  if (row !== undefined && isOpen(row)) resolveIn(draft, row, result, now)

  return draft.done(undefined)
}

/**
 * First message of a connection. Turns the runner is still executing are left alone; other open turns are
 * re-sent if recent (the runner never runs a key twice) or marked `unknown`, so a command never runs late by
 * surprise. Steers are never re-sent: the agent can't dedup them.
 */
export const hello = (slice: Slice, message: Runner.Hello, now: EpochMillis): Step<undefined> => {
  const draft = new Draft(slice)
  draft.commands.push(Command.cases.Attach.make({ hello: message }))
  draft.setAgentName(message.agent.name)
  const inFlight = new Set(message.in_flight)

  for (const row of draft.open()) {
    if (inFlight.has(row.key)) continue

    if (row.steer_into === null && now - row.created_at < Duration.toMillis(RESEND_WINDOW)) {
      draft.putTurn({ ...row, state: "sent", updated_at: now })
      draft.commands.push(
        Command.cases.Send.make({ message: turnMessage(row, draft.sessionOf(row).agent_session_id) })
      )
    } else {
      resolveIn(draft, row, undefined, now)
    }
  }

  return draft.done(undefined)
}

/** Starts `new` or `compact` on a session that isn't running a turn. */
export const sessionOp = (
  slice: Slice,
  op: { readonly session: Common.SessionName; readonly op: Runner.SessionOp["op"]; readonly opId: Runner.OpId },
  runner: LiveRunner | undefined
): Step<SessionOpAnswer> => {
  const draft = new Draft(slice)

  if (!runner) return draft.done(Result.fail(offline()))
  const session = draft.session(op.session) ?? emptySession(op.session)

  if (session.active_key !== null) {
    return draft.done(
      Result.fail(new SessionBusy({ message: "The agent is still working on a command in this session." }))
    )
  }

  draft.commands.push(Command.cases.Send.make({ message: sessionOpMessage(op.opId, op.op, session) }))

  return draft.done(Result.void)
}

/** How a session op ended for the request waiting on it (`None`: the runner didn't answer in time). */
export const sessionOpResult = (
  answered: Option.Option<SessionOpOutcome>
): Result.Result<void, OpNotSupported | OpFailed> =>
  Option.match(answered, {
    onNone: () => Result.fail(new OpFailed({ message: "The runner didn't answer." })),
    onSome: (answer) => {
      if (answer.type === "session_op_result") return Result.void

      return answer.code === "not_supported"
        ? Result.fail(new OpNotSupported({ message: answer.message }))
        : Result.fail(new OpFailed({ message: answer.message }))
    }
  })

/** The runner answered a waiting session op: a success moves the session to the agent session it names. */
export const sessionOpAnswer = (
  slice: Slice,
  answer: { readonly session: Common.SessionName; readonly opId: Runner.OpId; readonly outcome: SessionOpOutcome },
  now: EpochMillis
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

  draft.commands.push(Command.cases.Answer.make({ opId: answer.opId, outcome: answer.outcome }))

  return draft.done(undefined)
}

/** Daily cleanup: prune old resolved turns, and run again in a day. */
export const alarm = (now: EpochMillis): Step<undefined> => {
  const draft = new Draft({ turns: [], sessions: [] })
  draft.prune(EpochMillis.make(now - Duration.toMillis(TURN_RETENTION)))
  draft.commands.push(Command.cases.SetAlarm.make({ at: after(now, CLEANUP_INTERVAL) }))

  return draft.done(undefined)
}

type Answer = LiveRunner | SubmitAnswer | SessionOpAnswer | undefined

/** The step for any event. */
export const step = (slice: Slice, event: Event, now: EpochMillis): Step<Answer> =>
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

  if (row.state !== "done") return { status: "running", ...base, retry_after_ms: Duration.toMillis(RETRY_AFTER) }

  return Outcome.match(row.outcome, {
    result: (
      { type: _type, key: _key, agent_session_id: _agentSessionId, ...answer }
    ): typeof Turn.TurnState.Encoded => {
      const completed = { status: "completed", ...base, ...answer } as const

      return row.transcript_raw === null ? completed : { ...completed, transcript_raw: row.transcript_raw }
    },
    needs_approval: ({ message }): typeof Turn.TurnState.Encoded => ({ status: "needs_approval", ...base, message }),
    turn_failed: ({ code, message }): typeof Turn.TurnState.Encoded => ({ status: "failed", ...base, code, message }),
    merged: ({ into }): typeof Turn.TurnState.Encoded => ({ status: "merged", ...base, into })
  })
}

/** A session's state as clients see it. A session no turn has used yet is idle. */
export const sessionState = (
  name: Common.SessionName,
  row: SessionRow | undefined
): typeof Status.SessionState.Encoded => {
  const state = { name, busy: row !== undefined && row.active_key !== null }
  const withContext = row?.context ? { ...state, context: row.context } : state

  return row?.last_activity == null
    ? withContext
    : { ...withContext, last_activity: new Date(row.last_activity).toISOString() }
}

/** `GET /v1/status`. `agentName` is absent until a runner first says hello. */
export const status = (
  agentName: string | undefined,
  online: boolean,
  session: typeof Status.SessionState.Encoded
): typeof Status.Status.Encoded => ({
  agent: agentName === undefined ? { online } : { name: agentName, online },
  session
})
