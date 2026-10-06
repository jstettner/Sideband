import { Hono } from "hono"

export interface Env {}

const app = new Hono<{ Bindings: Env }>()

app.get("/healthz", (c) => c.text("ok"))

export default app
