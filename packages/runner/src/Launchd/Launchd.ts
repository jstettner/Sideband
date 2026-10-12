/**
 * launchd, as far as installing the runner needs it: the per-user (`gui/<uid>`) domain's `launchctl`
 * subcommands. A narrow service, so installing is tested with a recording fake instead of the real launchd.
 */
import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream, type Types } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** `launchctl` failed, or couldn't be run. */
export class LaunchdError extends Schema.TaggedError<LaunchdError>()("LaunchdError", {
  message: Schema.String
}) {}

/** What `launchctl print` says about a loaded job. */
export interface Job {
  /** Absent when the job isn't running. */
  readonly pid?: number
  /** As launchctl prints it: a number, or a note such as `(never exited)`. */
  readonly lastExitCode?: string
}

export class Launchd extends Context.Service<Launchd, {
  readonly isLoaded: (label: string) => Effect.Effect<boolean, LaunchdError>
  /** Loads the job the property list at `plist` describes, which starts it (`RunAtLoad`). */
  readonly bootstrap: (plist: string) => Effect.Effect<void, LaunchdError>
  /** Stops and unloads the job, returning once launchd no longer has it. */
  readonly bootout: (label: string) => Effect.Effect<void, LaunchdError>
  /** Restarts the job, killing it first if it's running. */
  readonly kickstart: (label: string) => Effect.Effect<void, LaunchdError>
  /** The job, if it's loaded. */
  readonly job: (label: string) => Effect.Effect<Option.Option<Job>, LaunchdError>
}>()("@sideband/runner/Launchd") {}

const UNLOAD_POLL = Duration.millis(100)

/** How often `bootout` checks the job is gone before giving up: about ten seconds. */
const UNLOAD_POLLS = 100

/** Reads the fields {@link Job} needs from `launchctl print` output. */
export const parsePrint = (output: string): Job => {
  const pid = output.match(/^\s*pid = (\d+)\s*$/mu)?.[1]
  const lastExitCode = output.match(/^\s*last exit code = (.+?)\s*$/mu)?.[1]
  const job: Types.Mutable<Job> = {}

  if (pid !== undefined) job.pid = Number(pid)

  if (lastExitCode !== undefined) job.lastExitCode = lastExitCode

  return job
}

/** `launchctl` in the domain of the user `uid`. */
export const layer = (uid: number): Layer.Layer<Launchd, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    Launchd,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const domain = `gui/${uid}`

      /** Runs `launchctl args`, answering its exit code and output. */
      const launchctl = Effect.fnUntraced(
        function*(args: ReadonlyArray<string>) {
          const handle = yield* spawner.spawn(ChildProcess.make("launchctl", args))
          const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString)
          const code = yield* handle.exitCode

          return { code, output }
        },
        Effect.scoped,
        Effect.mapError((e) => new LaunchdError({ message: `launchctl: ${e.message}` }))
      )

      const succeed = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
        const { code, output } = yield* launchctl(args)

        if (code !== 0) {
          return yield* new LaunchdError({ message: `launchctl ${args.join(" ")} exited ${code}: ${output.trim()}` })
        }
      })

      const job = Effect.fn("Launchd.job")(function*(label: string) {
        const { code, output } = yield* launchctl(["print", `${domain}/${label}`])

        return code === 0 ? Option.some(parsePrint(output)) : Option.none()
      })

      return Launchd.of({
        isLoaded: Effect.fn("Launchd.isLoaded")(function*(label: string) {
          return Option.isSome(yield* job(label))
        }),
        bootstrap: Effect.fn("Launchd.bootstrap")((plist: string) => succeed(["bootstrap", domain, plist])),
        // `launchctl bootout` returns while the job is still being torn down, and a `bootstrap` of the same
        // label meanwhile fails with error 5 (Input/output error), so wait until the job is gone.
        bootout: Effect.fn("Launchd.bootout")(function*(label: string) {
          yield* succeed(["bootout", `${domain}/${label}`])

          yield* job(label).pipe(
            Effect.repeat({ schedule: Schedule.spaced(UNLOAD_POLL), until: Option.isNone, times: UNLOAD_POLLS }),
            Effect.filterOrFail(
              Option.isNone,
              () => new LaunchdError({ message: `${label} was still loaded ${UNLOAD_POLLS} checks after bootout` })
            )
          )
        }),
        kickstart: Effect.fn("Launchd.kickstart")((label: string) =>
          succeed(["kickstart", "-k", `${domain}/${label}`])
        ),
        job
      })
    })
  )
