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

/**
 * Force the agent to re-process a specific thread. Useful when we've shipped
 * a code/prompt change and want to refresh existing drafts without waiting
 * for new customer activity.
 *
 * - Deletes any existing draft we created in that thread (so a fresh one can
 *   take its place).
 * - Resets the thread's bookkeeping so the next tick treats it as new.
 */
app.post("/thread/:id/redraft", async (c) => {
  const threadId = c.req.param("id")
  if (!threadId) return c.text("missing thread id", 400)
  try {
    const { db } = await import("./db/pool.js")
    // Pull current meta to find any existing draft we created
    const existing = await db().query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM inbox_threads WHERE thread_id = $1`,
      [threadId]
    )
    const draftId = existing.rows[0]?.meta?.["draftId"] as string | undefined

    // Best-effort: delete any prior draft we made
    if (draftId) {
      try {
        const { google } = await import("googleapis")
        const { ensureGoogleAuthed } = await import("./google/oauth.js")
        const auth = await ensureGoogleAuthed()
        const gmail = google.gmail({ version: "v1", auth })
        await gmail.users.drafts.delete({ userId: "me", id: draftId })
      } catch (e) {
        console.warn(
          "[redraft] could not delete old draft:",
          e instanceof Error ? e.message : e
        )
      }
    }

    // Reset the thread so the next tick re-processes it. We clear
    // last_message_id (forces "new activity") and last_action.
    await db().query(
      `UPDATE inbox_threads
          SET last_message_id = '__forced_redraft__',
              last_action = NULL,
              meta = '{}'::jsonb
        WHERE thread_id = $1`,
      [threadId]
    )

    // Process this specific thread directly (bypasses the unread filter)
    const { processThread } = await import("./pipeline.js")
    const acted = await processThread(threadId)
    return c.json({ ok: true, redrafted: threadId, acted })
  } catch (e) {
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      500
    )
  }
})

/**
 * Find a thread by substring of the customer's email body. Used for ad-hoc
 * debug: "redraft the Jenna thread" -> hit /thread/find?q=jenna -> get id.
 */
app.get("/thread/find", async (c) => {
  const q = c.req.query("q")
  if (!q) return c.text("missing ?q=", 400)
  const { google } = await import("googleapis")
  const { ensureGoogleAuthed } = await import("./google/oauth.js")
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })
  const r = await gmail.users.threads.list({
    userId: "me",
    q: q + " newer_than:60d",
    maxResults: 10,
  })
  const out: Array<{ id: string; subject: string; from: string }> = []
  for (const t of r.data.threads ?? []) {
    if (!t.id) continue
    const m = await gmail.users.threads.get({
      userId: "me",
      id: t.id,
      format: "metadata",
      metadataHeaders: ["Subject", "From"],
    })
    const first = m.data.messages?.[0]
    const header = (n: string): string =>
      first?.payload?.headers?.find(
        (h) => h.name?.toLowerCase() === n.toLowerCase()
      )?.value ?? ""
    out.push({ id: t.id, subject: header("Subject"), from: header("From") })
  }
  return c.json(out)
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
