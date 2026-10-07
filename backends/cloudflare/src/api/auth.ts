import { Authorization, Principal, Unauthorized } from "@sideband/protocol"
import { Effect, Layer, Redacted } from "effect"

const encoder = new TextEncoder()

/** Compares in time independent of where the strings first differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const unauthorized = new Unauthorized({
  error: "unauthorized",
  message: "missing or invalid bearer token",
  retryable: false
})

/** Single-user MVP: one watch token, one principal. */
export const layer = (watchToken: string) =>
  Layer.succeed(Authorization)({
    bearer: (effect, { credential }) =>
      watchToken !== "" && constantTimeEqual(Redacted.value(credential), watchToken)
        ? Effect.provideService(effect, Principal, { userId: "owner" })
        : Effect.fail(unauthorized)
  })
