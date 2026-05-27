import { serve } from "@hono/node-server"
import { Hono } from "hono"
import "dotenv/config"

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// OAuth callbacks will be wired here in P1:
//   app.get('/oauth/gmail/callback', ...)
//   app.get('/oauth/xero/callback', ...)

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`[tarte-inbox] http listening on :${port}`)
  console.log(`[tarte-inbox] scaffold only — no poll loop yet`)
})
