/**
 * Sent as `instructions` with every Hermes run, i.e. every turn. Hermes doesn't store it in the
 * session: it appends it to the session's system prompt on each model call. It's constant, so the
 * prompt cache still matches from turn to turn; editing it costs one cache miss per session, and
 * turns in flight during the change get `409 idempotency_key_conflict` on retry (it's part of the
 * idempotency fingerprint).
 */
export const watchInstructions = `\
This message was spoken on a smartwatch and transcribed, so it may contain recognition errors; \
read it for what the user most likely meant. Your reply is shown on the watch's small screen.`
