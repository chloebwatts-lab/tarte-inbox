import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import type { Context } from "hono"
import { config } from "./config.js"
import {
  googleAuthUrl,
  exchangeGoogleCode,
} from "./google/oauth.js"
import { xeroAuthUrl, exchangeXeroCallback } from "./xero/client.js"
import {
  runTick,
  progressBookingToInvoice,
  getInvoiceForEdit,
  regenerateInvoiceFromEdits,
  listInvoices,
  createManualInvoice,
  listReviewQueue,
  queueSendDraft,
  dismissThread,
  type InvoiceEdits,
} from "./pipeline.js"
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

app.post("/sync-nbi", async (c) => {
  const { ingestNbi } = await import("./nbi/ingest.js")
  const r = await ingestNbi(7)
  return c.json(r)
})

// Manual digest trigger (ignores the 07:00 gate but still once per day —
// delete today's inbox_digest_log row to re-send).
app.post("/digest/run", async (c) => {
  const { sendDailyDigest } = await import("./digest.js")
  return c.json(await sendDailyDigest())
})

app.post("/followups/run", async (c) => {
  const { nudgeStaleBookings } = await import("./followups.js")
  return c.json(await nudgeStaleBookings())
})

app.post("/calendar-sync/run", async (c) => {
  const { syncCombinedCalendar } = await import("./google/calendar-sync.js")
  const r = await syncCombinedCalendar()
  return c.json(
    r ?? {
      ok: false,
      reason:
        "combined calendar unavailable — re-authorise Google at /oauth/google/start (full calendar scope needed once)",
    }
  )
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

    // Process this specific thread directly (bypasses unread filter AND
    // the "skip if our team already replied" guard, so we can test prompt
    // changes on threads Georgia/Shawna already touched).
    const { processThread } = await import("./pipeline.js")
    const acted = await processThread(threadId, { force: true })
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

// --- Quick-amend invoice form ---
// Staff open this (linked from the daily digest) to tweak a field on an
// auto-generated invoice and regenerate the PDF + in-thread draft. No PDF
// hand-editing — the totals always recalculate.

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string)
  )

// The invoice pages are password-free but gated by a secret token (capability
// URL). Presenting ?k=<token> once sets a cookie so all the links + the form
// then work without re-passing it. Closed (403) until INVOICE_PORTAL_TOKEN is set.
function portalAuthed(c: Context): boolean {
  const token = config().INVOICE_PORTAL_TOKEN
  if (!token) return false
  const k = c.req.query("k")
  if (k && k === token) {
    setCookie(c, "inv_portal", token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 60, // 60 days
    })
    return true
  }
  return getCookie(c, "inv_portal") === token
}

function editForm(invoiceNumber: string, x: Record<string, unknown>, kind: string, msg?: string): string {
  const field = (label: string, name: string, value: unknown, type = "text"): string =>
    `<label>${esc(label)}<input type="${type}" name="${name}" value="${esc(value)}"${
      type === "number" ? ' step="any"' : ""
    }></label>`
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Edit ${esc(invoiceNumber)}</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#3a3a3a}
 h1{font-size:18px;color:#6e8d85} .tag{color:#8a8a8a;font-size:13px}
 label{display:block;margin:10px 0;font-size:13px;color:#6e8d85}
 input{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:3px;font-size:15px;border:1px solid #d9e2df;border-radius:6px;color:#3a3a3a}
 button{margin-top:16px;background:#6e8d85;color:#fff;border:0;border-radius:6px;padding:11px 18px;font-size:15px;cursor:pointer}
 .msg{background:#f3f7f6;border-radius:6px;padding:10px 12px;margin:12px 0}
 .note{color:#8a8a8a;font-size:12px;margin-top:14px}
 a.back{color:#8a8a8a;font-size:13px;text-decoration:none}
</style>
<a class="back" href="/invoices">← All invoices</a>
<h1>Edit invoice ${esc(invoiceNumber)}</h1>
<div class="tag">${esc(kind === "balance" ? "Balance invoice" : "Deposit invoice")} — change a field and regenerate. Totals recalculate automatically.</div>
${msg ? `<div class="msg">${msg}</div>` : ""}
<form method="post" action="/invoice/edit">
 <input type="hidden" name="n" value="${esc(invoiceNumber)}">
 ${field("Customer name", "customer_name", x["customer_name"])}
 ${field("Customer email", "customer_email", x["customer_email"])}
 ${field("Event type", "event_type", x["event_type"])}
 ${field("Package", "package_name", x["package_name"])}
 ${field("Venue space", "venue_space", x["venue_space"])}
 ${field("Date (YYYY-MM-DD)", "event_date", x["event_date"])}
 ${field("Time", "time_label", x["time_label"])}
 ${field("Guests", "guests", x["guests"], "number")}
 ${field("Price per person ($)", "per_person_price", x["per_person_price"], "number")}
 ${field("Deposit %", "deposit_pct", x["deposit_pct"], "number")}
 ${field("Dietaries", "dietaries", x["dietaries"])}
 <button type="submit">Regenerate invoice &amp; draft</button>
</form>
<div class="note">This rebuilds the PDF and refreshes the draft in the email thread (BCC accounts &amp; Shawna). It does not send — review and send from Gmail as usual.</div>`
}

app.get("/invoices", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised — open this from your invoices link.", 403)
  const rows = await listInvoices()
  const fmt = (n: unknown): string => `$${Number(n ?? 0).toLocaleString("en-AU")}`
  const body = rows
    .map((r) => {
      const editable = r.editable
      const action = editable
        ? `<a href="/invoice/edit?n=${encodeURIComponent(r.invoice_number)}">Edit</a>`
        : `<span class="muted">not editable*</span>`
      const pay = r.payment_status ? ` · <span class="pay ${esc(r.payment_status)}">${esc(r.payment_status)}</span>` : ""
      return `<tr>
        <td><b>${esc(r.invoice_number)}</b>${r.kind === "balance" ? ' <span class="bal">BAL</span>' : ""}</td>
        <td>${esc(r.customer_name) || "?"}</td>
        <td class="r">${fmt(r.amount)}</td>
        <td>${esc(String(r.created_at).slice(0, 10))}${pay}</td>
        <td>${action}</td>
      </tr>`
    })
    .join("")
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tarte invoices</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#3a3a3a}
 h1{font-size:19px;color:#6e8d85} table{border-collapse:collapse;width:100%;margin-top:12px}
 th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #eef2f1;font-size:14px}
 th{color:#8a8a8a;font-weight:600;font-size:12px;text-transform:uppercase}
 td.r{text-align:right} a{color:#6e8d85;font-weight:600} .muted{color:#b3b3b3}
 .bal{font-size:10px;background:#eef3f2;color:#6e8d85;padding:1px 5px;border-radius:4px}
 .pay{font-size:11px;text-transform:capitalize} .pay.verified{color:#3f8f5f} .pay.unmatched,.pay.claimed{color:#c08a2a}
 .find{margin:14px 0} .find input{padding:8px;border:1px solid #d9e2df;border-radius:6px;font-size:15px}
 .note{color:#8a8a8a;font-size:12px;margin-top:16px}
</style>
<h1>Invoices</h1>
<p><a href="/invoice/new"><b>+ New invoice</b></a></p>
<form class="find" action="/invoice/edit" method="get">
  <input type="text" name="n" placeholder="Find by number, e.g. TARTE-2026-00006" size="32">
  <button type="submit">Open</button>
</form>
<table><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Date</th><th></th></tr>${body}</table>
<div class="note">* Older invoices created before the edit feature have no stored detail to regenerate from. Any invoice generated from now on is editable.</div>`)
})

function newInvoiceForm(msg?: string): string {
  const field = (label: string, name: string, type = "text", placeholder = ""): string =>
    `<label>${esc(label)}<input type="${type}" name="${name}" placeholder="${esc(placeholder)}"${
      type === "number" ? ' step="any"' : ""
    }></label>`
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>New invoice</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;padding:0 16px;color:#3a3a3a}
 h1{font-size:18px;color:#6e8d85}
 label{display:block;margin:10px 0;font-size:13px;color:#6e8d85}
 input{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:3px;font-size:15px;border:1px solid #d9e2df;border-radius:6px;color:#3a3a3a}
 button{margin-top:16px;background:#6e8d85;color:#fff;border:0;border-radius:6px;padding:11px 18px;font-size:15px;cursor:pointer}
 .msg{background:#f3f7f6;border-radius:6px;padding:10px 12px;margin:12px 0}
 .note{color:#8a8a8a;font-size:12px;margin-top:14px}
 a.back{color:#8a8a8a;font-size:13px;text-decoration:none}
</style>
<a class="back" href="/invoices">← All invoices</a>
<h1>New invoice</h1>
${msg ? `<div class="msg">${msg}</div>` : ""}
<form method="post" action="/invoice/new">
 ${field("Customer name *", "customer_name")}
 ${field("Customer email *", "customer_email")}
 ${field("Event type", "event_type", "text", "e.g. Baby Shower")}
 ${field("Package", "package_name", "text", "e.g. Private High Tea in The Hideout")}
 ${field("Venue space", "venue_space", "text", "The Hideout / Tea Garden / Beach House")}
 ${field("Date (YYYY-MM-DD)", "event_date")}
 ${field("Time", "time_label", "text", "e.g. 11:00am - 2:00pm")}
 ${field("Guests *", "guests", "number")}
 ${field("Price per person ($) *", "per_person_price", "number")}
 ${field("Deposit % (default 50)", "deposit_pct", "number")}
 ${field("Dietaries", "dietaries")}
 <button type="submit">Create invoice &amp; draft email</button>
</form>
<div class="note">Creates the branded PDF and a draft email to the customer with it attached (BCC accounts &amp; Shawna). It does not send — review and send from Gmail Drafts. Don't double-submit: each submit makes a new invoice number.</div>`
}

app.get("/invoice/new", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised — open this from your invoices link.", 403)
  return c.html(newInvoiceForm())
})

app.post("/invoice/new", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised — open this from your invoices link.", 403)
  const form = await c.req.parseBody()
  const str = (k: string): string | undefined => {
    const v = form[k]
    const s = typeof v === "string" ? v.trim() : ""
    return s === "" ? undefined : s
  }
  const num = (k: string): number | undefined => {
    const s = str(k)
    if (s === undefined) return undefined
    const v = Number(s)
    return Number.isFinite(v) ? v : undefined
  }
  const result = await createManualInvoice({
    customer_name: str("customer_name") ?? "",
    customer_email: str("customer_email") ?? "",
    event_type: str("event_type"),
    package_name: str("package_name"),
    venue_space: str("venue_space"),
    event_date: str("event_date"),
    time_label: str("time_label"),
    guests: num("guests"),
    per_person_price: num("per_person_price"),
    deposit_pct: num("deposit_pct"),
    dietaries: str("dietaries"),
  })
  const msg = result.ok
    ? `✅ Created <b>${esc(result.invoiceNumber)}</b> — the draft email (PDF attached) is in Gmail Drafts, ready to review and send.`
    : `⚠️ ${esc(result.error)}`
  return c.html(newInvoiceForm(msg))
})

app.get("/invoice/edit", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised — open this from your invoices link.", 403)
  const n = c.req.query("n")
  if (!n) return c.text("missing ?n=<invoice number>", 400)
  const rec = await getInvoiceForEdit(n)
  if (!rec) return c.text("invoice not found", 404)
  if (!rec.editable) return c.text("this invoice has no stored detail to edit", 400)
  return c.html(editForm(n, rec.editable as unknown as Record<string, unknown>, rec.kind))
})

app.post("/invoice/edit", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised — open this from your invoices link.", 403)
  const form = await c.req.parseBody()
  const n = String(form["n"] ?? "")
  if (!n) return c.text("missing invoice number", 400)
  const str = (k: string): string | undefined => {
    const v = form[k]
    const s = typeof v === "string" ? v.trim() : ""
    return s === "" ? undefined : s
  }
  const num = (k: string): number | undefined => {
    const s = str(k)
    if (s === undefined) return undefined
    const v = Number(s)
    return Number.isFinite(v) ? v : undefined
  }
  const edits: InvoiceEdits = {
    customer_name: str("customer_name"),
    customer_email: str("customer_email"),
    event_type: str("event_type"),
    package_name: str("package_name"),
    venue_space: str("venue_space"),
    event_date: str("event_date"),
    time_label: str("time_label"),
    dietaries: str("dietaries"),
    guests: num("guests"),
    per_person_price: num("per_person_price"),
    deposit_pct: num("deposit_pct"),
  }
  const result = await regenerateInvoiceFromEdits(n, edits)
  const rec = await getInvoiceForEdit(result.ok ? result.invoiceNumber : n)
  const msg = result.ok
    ? `✅ Regenerated <b>${esc(result.invoiceNumber)}</b> — the updated PDF is now on the draft in Gmail, ready to review and send.`
    : `⚠️ ${esc(result.error)}`
  if (!rec) return c.html(`<p>${msg}</p>`)
  return c.html(editForm(rec.invoice_number, (rec.editable ?? {}) as unknown as Record<string, unknown>, rec.kind, msg))
})

// --- Review queue: pending drafts, one tap to send (human-approved) ---

app.get("/queue", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised — open this from your queue link.", 403)
  const items = await listReviewQueue()
  const msg = c.req.query("m")
  const cards = items
    .map((it) => {
      const cat = it.category ? esc(it.category.replace(/_/g, " ")) : "email"
      const flags = it.flags.filter((f) => f !== "needs_human").map(esc).join(", ")
      return `<div class="card">
  <div class="who">${esc(it.customerFrom.replace(/<[^>]*>/g, "").trim() || it.customerFrom)}</div>
  <div class="subj">${esc(it.subject)} <span class="cat">${cat}${it.hasInvoice ? " · 💸 invoice attached" : ""}${flags ? " · " + flags : ""}</span></div>
  <div class="cust">“${esc(it.customerSnippet)}”</div>
  <div class="draft">${esc(it.draftBody)}</div>
  <div class="row">
    <form method="post" action="/queue/send" onsubmit="return confirm('Send this reply now?')">
      <input type="hidden" name="t" value="${esc(it.threadId)}"><button class="send">Send ✓</button>
    </form>
    <a class="open" href="https://mail.google.com/mail/u/0/#all/${esc(it.threadId)}" target="_blank">Edit in Gmail</a>
    <form method="post" action="/queue/dismiss" onsubmit="return confirm('Dismiss this? The draft will be deleted and no reply sent.')">
      <input type="hidden" name="t" value="${esc(it.threadId)}"><button class="dismiss">Dismiss</button>
    </form>
  </div>
</div>`
    })
    .join("\n")
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tarte reply queue</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:18px auto;padding:0 14px;color:#3a3a3a;background:#fafcfb}
 h1{font-size:19px;color:#6e8d85;margin-bottom:2px} .sub{color:#8a8a8a;font-size:13px;margin-bottom:14px}
 .msg{background:#eef7f2;border-radius:8px;padding:10px 12px;margin:10px 0;font-size:14px}
 .card{background:#fff;border:1px solid #e2e8e6;border-radius:10px;padding:14px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
 .who{font-weight:700} .subj{color:#6e8d85;font-size:13px;margin:2px 0 8px} .cat{color:#a9b5b1;font-weight:400}
 .cust{color:#8a8a8a;font-size:13px;border-left:3px solid #e2e8e6;padding-left:9px;margin-bottom:9px}
 .draft{white-space:pre-wrap;background:#f6f9f8;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:10px}
 .row{display:flex;gap:8px;align-items:center} .row form{margin:0}
 button{border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer}
 .send{background:#6e8d85;color:#fff;font-weight:700} .dismiss{background:#f3e9e7;color:#a05c4c}
 a.open{color:#6e8d85;font-size:13px;font-weight:600;text-decoration:none;padding:10px 4px}
 .empty{background:#fff;border:1px dashed #cfdcd8;border-radius:10px;padding:26px;text-align:center;color:#8a8a8a}
</style>
<h1>Reply queue</h1>
<div class="sub">${items.length} draft${items.length === 1 ? "" : "s"} waiting. Read, then Send — or open in Gmail to tweak first. Sending here sends the draft exactly as it stands.</div>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
${cards || `<div class="empty">Nothing waiting — the inbox is clear 🎉</div>`}`)
})

app.post("/queue/send", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised.", 403)
  const form = await c.req.parseBody()
  const t = String(form["t"] ?? "")
  if (!t) return c.text("missing thread", 400)
  const r = await queueSendDraft(t)
  return c.redirect(`/queue?m=${encodeURIComponent(r.ok ? "Sent ✓" : `Not sent: ${r.error}`)}`)
})

app.post("/queue/dismiss", async (c) => {
  if (!portalAuthed(c)) return c.text("Not authorised.", 403)
  const form = await c.req.parseBody()
  const t = String(form["t"] ?? "")
  if (!t) return c.text("missing thread", 400)
  await dismissThread(t, "dismissed_queue")
  return c.redirect(`/queue?m=${encodeURIComponent("Dismissed — draft removed, no reply will be sent.")}`)
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
    faq: Array.isArray(body["faq"])
      ? (body["faq"] as Array<{ question: string; answer: string }>)
      : [],
  })
  return c.json({ ok: true })
})
