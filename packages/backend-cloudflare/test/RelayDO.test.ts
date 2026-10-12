/**
 * How the Relay handles failures at its edges, through the pieces `RelayDO.ts` composes: what reaches the
 * caller as an error, what is a defect, and what recovers through the runner's next `hello`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { SqlError } from "effect/sql"
import * as Lifecycle from "../src/Relay/Lifecycle.ts"
import * as RelayDO from "../src/Relay/RelayDO.ts"

const sqlError = new SqlError.SqlError({
  reason: new SqlError.UnknownError({ cause: new Error("SQLITE_FULL"), message: "database full", operation: "execute" })
})

describe("storageErrors", () => {
  it.effect("a storage failure is a StorageFailed error the caller sees", () =>
    Effect.gen(function*() {
      const error = yield* RelayDO.storageErrors(Effect.fail(sqlError)).pipe(Effect.flip)

      expect(error).toBeInstanceOf(Lifecycle.StorageFailed)
    }))

  it.effect("a stored row that doesn't decode is a defect: the table's checks rule it out", () =>
    Effect.gen(function*() {
      const undecodable = Schema.decodeUnknownEffect(Lifecycle.TurnRow)({ key: "nope" })
      const exit = yield* RelayDO.storageErrors(undecodable).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }))
})

describe("closeOnStorageFailure", () => {
  it.effect("a runner frame that can't be saved closes the socket, so the runner's next hello recovers it", () =>
    Effect.gen(function*() {
      const closed: Array<number> = []
      const close = (code: number) => Effect.sync(() => closed.push(code))

      yield* Effect.fail(new Lifecycle.StorageFailed({ message: "database full" })).pipe(
        RelayDO.closeOnStorageFailure(close)
      )

      expect(closed).toEqual([RelayDO.CLOSE_STORAGE_FAILED])
    }))

  it.effect("a frame that is saved leaves the socket open", () =>
    Effect.gen(function*() {
      const closed: Array<number> = []
      yield* Effect.void.pipe(RelayDO.closeOnStorageFailure((code) => Effect.sync(() => closed.push(code))))

      expect(closed).toEqual([])
    }))
})

describe("send", () => {
  it.effect("a socket that closed before the send is no error: the runner's next hello re-sends the turn", () =>
    Effect.gen(function*() {
      const closedSocket: RelayDO.Outbound = {
        send: () => {
          throw new Error("WebSocket is closed")
        }
      }

      expect(Exit.isSuccess(yield* RelayDO.send(closedSocket, "{}").pipe(Effect.exit))).toBe(true)
    }))

  it.effect("an open socket gets the frame", () =>
    Effect.gen(function*() {
      const frames: Array<string> = []
      yield* RelayDO.send({ send: (frame) => frames.push(frame) }, "{\"type\":\"turn\"}")

      expect(frames).toEqual(["{\"type\":\"turn\"}"])
    }))
})
