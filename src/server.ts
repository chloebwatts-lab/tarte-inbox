import { Hono } from "hono"
import { config } from "./config.js"
import {
  googleAuthUrl,
  exchangeGoogleCode,
} from "./google/oauth.js"
import { xeroAuthUrl, exchangeXeroCallback } from "./xero/client.js"
import { runTick, progressBookingToInvoice } from "./pipeline.js"
import { listPlaybooks, upsertPlaybook, getTokens } from "./db/queries.js"

export const app = new Hono()

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }))

app.get("/status", async (c) => {
  const [google, xero] = await Promise.all([
    getTokens("google"),
    getTokens("xero"),
  ])
  return c.json({
    google: { linked: !!google, expiry: google?.expiry, scope: google?.scope },
    xero: { linked: !!xero, expiry: xero?.expiry, scope: xero?.scope },
    auto_send: config().ENABLE_AUTO_SEND,
    tick_interval_s: config().TICK_INTERVAL_SECONDS,
  })
})

// --- OAuth ---

app.get("/oauth/google/start", (c) => {
  return c.redirect(googleAuthUrl("inbox"))
})

app.get("/oauth/google/callback", async (c) => {
  const code = c.req.query("code")
  if (!code) return c.text("missing ?code", 400)
  try {
    await exchangeGoogleCode(code)
    return c.text("google linked — you can close this tab.")
  } catch (e) {
    return c.text(`oauth failed: ${e instanceof Error ? e.message : String(e)}`, 500)
  }
})

app.get("/oauth/xero/start", async (c) => {
  return c.redirect(await xeroAuthUrl())
})

app.get("/oauth/xero/callback", async (c) => {
  try {
    await exchangeXeroCallback(c.req.url)
    return c.text("xero linked — you can close this tab.")
  } catch (e) {
    return c.text(`xero oauth failed: ${e instanceof Error ? e.message : String(e)}`, 500)
  }
})

// --- Manual triggers ---

app.post("/tick", async (c) => {
  const { seen, acted } = await runTick()
  return c.json({ seen, acted })
})

app.post("/booking/:id/invoice", async (c) => {
  const id = Number(c.req.param("id"))
  if (!Number.isFinite(id)) return c.text("bad id", 400)
  try {
    await progressBookingToInvoice(id)
    return c.json({ ok: true })
  } catch (e) {
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      500
    )
  }
})

// --- Playbooks (minimal admin until TK UI lands) ---

app.get("/playbooks", async (c) => c.json(await listPlaybooks()))

app.put("/playbooks/:category", async (c) => {
  const category = c.req.param("category")
  const body = (await c.req.json()) as Record<string, unknown>
  await upsertPlaybook({
    category,
    description: String(body["description"] ?? ""),
    voice_guidance: String(body["voice_guidance"] ?? ""),
    reply_template:
      typeof body["reply_template"] === "string"
        ? (body["reply_template"] as string)
        : null,
    auto_send: Boolean(body["auto_send"] ?? false),
    min_confidence:
      typeof body["min_confidence"] === "number"
        ? (body["min_confidence"] as number)
        : 0.85,
    examples: Array.isArray(body["examples"])
      ? (body["examples"] as Array<{ incoming: string; reply: string }>)
      : [],
    default_attachment_paths: Array.isArray(body["default_attachment_paths"])
      ? (body["default_attachment_paths"] as string[])
      : [],
    forward_to:
      typeof body["forward_to"] === "string" && body["forward_to"]
        ? (body["forward_to"] as string)
        : null,
  })
  return c.json({ ok: true })
})
