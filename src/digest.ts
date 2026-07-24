// Daily ops digest, emailed to hello@ at ~07:00 Brisbane. The staff workflow
// becomes: open the digest, click through the action list, done. Everything
// the agent handled autonomously is reported as counts, not work.

import { sendPlainEmail, getThreadMeta } from "./google/gmail.js"
import { nbiSyncStatus } from "./nbi/ingest.js"
import { db } from "./db/pool.js"
import { config } from "./config.js"

const DIGEST_HOUR_BRISBANE = 7

function brisbaneNow(): { date: string; hour: number; pretty: string } {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  })
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value])
  )
  return {
    date: `${parts["year"]}-${parts["month"]}-${parts["day"]}`,
    hour: Number(parts["hour"]),
    pretty: `${parts["weekday"]} ${Number(parts["day"])}/${parts["month"]}`,
  }
}

/** True when it's digest o'clock in Brisbane and today's hasn't gone yet. */
export async function digestDue(): Promise<boolean> {
  const { date, hour } = brisbaneNow()
  if (hour < DIGEST_HOUR_BRISBANE) return false
  const r = await db().query(
    `SELECT 1 FROM inbox_digest_log WHERE sent_date = $1`,
    [date]
  )
  return r.rows.length === 0
}

interface ActionThread {
  thread_id: string
  category: string | null
  state: string
  last_processed_at: Date
}

function gmailLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`
}

async function threadLines(rows: ActionThread[]): Promise<string[]> {
  const out: string[] = []
  for (const t of rows) {
    try {
      const m = await getThreadMeta(t.thread_id)
      const from = m.from.replace(/<[^>]+>/, "").trim() || m.from
      out.push(
        `  • ${m.subject || "(no subject)"} — ${from}\n    ${gmailLink(t.thread_id)}`
      )
    } catch {
      out.push(`  • ${gmailLink(t.thread_id)}`)
    }
  }
  return out
}

export async function sendDailyDigest(): Promise<{ sent: boolean }> {
  const { date, pretty } = brisbaneNow()

  const urgent = await db().query<ActionThread>(
    `SELECT thread_id, category, state, last_processed_at FROM inbox_threads
      WHERE state = 'urgent' AND last_processed_at > now() - interval '7 days'
      ORDER BY last_processed_at DESC LIMIT 10`
  )
  const drafts = await db().query<ActionThread>(
    `SELECT thread_id, category, state, last_processed_at FROM inbox_threads
      WHERE state IN ('drafted', 'forward_drafted')
        AND last_processed_at > now() - interval '7 days'
      ORDER BY last_processed_at DESC LIMIT 20`
  )
  const needsHuman = await db().query<ActionThread>(
    `SELECT thread_id, category, state, last_processed_at FROM inbox_threads
      WHERE ((state = 'classified' AND category IN ('needs_human', 'accounts_invoices'))
             OR state IN ('delivery_failure', 'draft_failed'))
        AND last_processed_at > now() - interval '3 days'
      ORDER BY last_processed_at DESC LIMIT 15`
  )
  const pipeline = await db().query<{
    id: number
    venue: string
    state: string
    customer_name: string | null
    pax: number | null
    event_start: Date | null
    age_days: number
  }>(
    `SELECT id, venue, state, customer_name, pax, event_start,
            EXTRACT(day FROM now() - updated_at)::int AS age_days
       FROM inbox_bookings
      WHERE state IN ('slots_proposed', 'slot_selected', 'deposit_invoiced')
      ORDER BY updated_at`
  )
  const handled = await db().query<{ last_action: string; n: number }>(
    `SELECT last_action, count(*)::int AS n FROM inbox_threads
      WHERE last_processed_at > now() - interval '24 hours'
        AND last_action IN ('archived_noreply', 'archived_marketing_cold_outreach',
                            'archived_no_action', 'sent', 'sent_forward')
      GROUP BY last_action`
  )

  // Invoices auto-generated in the last 24h — staff should review + send.
  const invoices = await db().query<{
    invoice_number: string
    customer_name: string | null
    amount: string
    kind: string
  }>(
    `SELECT invoice_number, customer_name, amount, kind FROM inbox_invoices
      WHERE created_at > now() - interval '24 hours'
      ORDER BY id DESC`
  )

  // Payment claims in the last 24h that we couldn't auto-verify in Xero — a
  // human needs to check the bank before we treat the deposit as received.
  const payments = await db().query<{
    invoice_number: string | null
    amount: string | null
    status: string
  }>(
    `SELECT invoice_number, amount, status FROM inbox_payments
      WHERE claimed_at > now() - interval '24 hours' AND status <> 'verified'
      ORDER BY id DESC`
  )

  const sections: string[] = []

  // The fastest way through the inbox: every pending draft on one page,
  // one tap to send. Pinned first so it's the habit.
  {
    const base = config().PUBLIC_BASE_URL.replace(/\/$/, "")
    const token = config().INVOICE_PORTAL_TOKEN
    if (token && drafts.rows.length) {
      sections.push(
        `⚡ FASTEST: review + send every waiting draft from one page:\n  ${base}/queue?k=${encodeURIComponent(token)}`
      )
    }
  }

  if (payments.rows.length) {
    sections.push(
      `🏦 Deposit "paid" — VERIFY in the bank, then send the confirmation draft (${payments.rows.length}):\n` +
        payments.rows
          .map(
            (p) =>
              `  • ${p.invoice_number ?? "?"} — $${Number(p.amount ?? 0).toLocaleString("en-AU")} (${
                p.status === "unmatched" ? "not found in Xero yet" : "Xero check pending"
              })`
          )
          .join("\n")
    )
  }

  if (invoices.rows.length) {
    const base = config().PUBLIC_BASE_URL.replace(/\/$/, "")
    const token = config().INVOICE_PORTAL_TOKEN
    const k = token ? `&k=${encodeURIComponent(token)}` : ""
    const browse = token ? `\n  Browse all invoices: ${base}/invoices?k=${encodeURIComponent(token)}` : ""
    sections.push(
      `💸 Invoices auto-generated — REVIEW the draft + invoice, then send (${invoices.rows.length}):\n` +
        invoices.rows
          .map((r) => {
            const isBal = r.kind === "balance"
            const amt = `$${Number(r.amount).toLocaleString("en-AU")}`
            const desc = isBal ? `balance of ${amt}` : `50% of ${amt}`
            return (
              `  • ${r.invoice_number}${isBal ? " (BALANCE)" : ""} — ${r.customer_name ?? "?"} (${desc})\n` +
              `    Need a tweak? Edit + regenerate: ${base}/invoice/edit?n=${encodeURIComponent(r.invoice_number)}${k}`
            )
          })
          .join("\n") +
        browse +
        `\n  Numbers changed? Apply the "Tarte / Update Invoice" label to the thread and the invoice rebuilds itself as a fresh draft.`
    )
  }

  if (urgent.rows.length) {
    sections.push(
      `🚨 URGENT — look at these first:\n` +
        (await threadLines(urgent.rows)).join("\n")
    )
  }
  if (drafts.rows.length) {
    sections.push(
      `✍️  Drafts ready — read, tweak if needed, hit send (${drafts.rows.length}):\n` +
        (await threadLines(drafts.rows)).join("\n")
    )
  }

  // Website form submissions are answered as standalone drafts addressed to
  // the real customer (the form arrives from a relay, e.g. Squarespace). They
  // live in the Drafts folder, not on the form thread — call them out by name
  // so staff know where to look.
  const formDrafts = await db().query<{
    email: string | null
    category: string | null
    state: string
  }>(
    `SELECT meta->>'formEmail' AS email, meta->>'category' AS category, state
       FROM inbox_threads
      WHERE state IN ('form_drafted', 'form_forward_drafted')
        AND last_processed_at > now() - interval '7 days'
      ORDER BY last_processed_at DESC LIMIT 20`
  )
  if (formDrafts.rows.length) {
    sections.push(
      `📬 Website form replies — drafts are in your DRAFTS folder, addressed to each customer (${formDrafts.rows.length}):\n` +
        formDrafts.rows
          .map(
            (r) =>
              `  • ${r.email ?? "(unknown)"}${
                r.state === "form_forward_drafted"
                  ? " — forwarded to work@"
                  : r.category
                    ? ` — ${r.category.replace(/_/g, " ")}`
                    : ""
              }`
          )
          .join("\n")
    )
  }
  if (needsHuman.rows.length) {
    sections.push(
      `🧐 Needs a human decision (${needsHuman.rows.length}):\n` +
        (await threadLines(needsHuman.rows)).join("\n")
    )
  }
  if (pipeline.rows.length) {
    const venueName = (v: string): string =>
      v === "tea_garden" ? "Tea Garden" : "Beach House"
    sections.push(
      `📅 Function bookings in flight:\n` +
        pipeline.rows
          .map((b) => {
            const who = b.customer_name ?? "unknown"
            const paxStr = b.pax ? `, ${b.pax} pax` : ""
            if (b.state === "slots_proposed")
              return `  • ${who} (${venueName(b.venue)}${paxStr}) — slots proposed ${b.age_days}d ago, awaiting reply`
            if (b.state === "deposit_invoiced")
              return `  • ${who} (${venueName(b.venue)}${paxStr}) — deposit invoiced${b.event_start ? `, event ${new Date(b.event_start).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane" })}` : ""} — check payment in Xero`
            return `  • ${who} (${venueName(b.venue)}${paxStr}) — ${b.state.replace(/_/g, " ")}`
          })
          .join("\n")
    )
  }
  // NBI sync visibility — and a loud warning if the daily summary email has
  // stopped arriving (availability checks degrade silently without it).
  try {
    const nbi = await nbiSyncStatus()
    const ageH = nbi.lastIngest
      ? (Date.now() - new Date(nbi.lastIngest).getTime()) / 3600_000
      : Infinity
    const svc = Object.entries(nbi.byService7d)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ")
    if (ageH > 36) {
      sections.push(
        `⚠️  Now Book It sync is STALE — no summary email ingested in ${Math.round(ageH)}h. Check that the NBI daily summary is still being emailed to hello@, or function availability checks will miss high teas.`
      )
    } else {
      sections.push(
        `📒 Now Book It: synced (last summary ${Math.round(ageH)}h ago). Next 7 days: ${nbi.upcoming7d} bookings${svc ? ` (${svc})` : ""}.`
      )
    }
  } catch {
    // digest must never fail on a side-section
  }

  // Every blank FAQ answer is a question the agent can't answer yet.
  try {
    const gaps = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM inbox_playbooks,
              jsonb_array_elements(faq) AS f
        WHERE coalesce(f->>'answer', '') = ''`
    )
    const n = gaps.rows[0]?.n ?? 0
    if (n) {
      sections.push(
        `📋 ${n} FAQ answer(s) still blank in the TK admin (kitchen.tarte.com.au/inbox-playbooks) — each one filled in is a question the agent answers perfectly forever.`
      )
    }
  } catch {
    // never fail the digest on a side-section
  }

  // House notes visibility: any live-guidance note or suggestion added since
  // the last digest is called out so changes to the agent's behaviour are
  // never invisible to Chloe.
  try {
    const { houseNoteDigestStats } = await import("./db/queries.js")
    const hn = await houseNoteDigestStats()
    if (hn.recent.length || hn.openSuggestions) {
      const lines: string[] = []
      const newNotes = hn.recent.filter((n) => n.kind === "note")
      const newSuggestions = hn.recent.filter((n) => n.kind === "suggestion")
      if (newNotes.length) {
        const authors = [...new Set(newNotes.map((n) => n.author))].join(", ")
        lines.push(
          `🗒️ ${newNotes.length} new house note(s) added by ${authors} — now live in the agent's drafting guidance:\n` +
            newNotes.map((n) => `  • ${n.body.slice(0, 160)}`).join("\n")
        )
      }
      if (newSuggestions.length) {
        const authors = [...new Set(newSuggestions.map((n) => n.author))].join(", ")
        lines.push(`💡 ${newSuggestions.length} new suggestion(s) from ${authors} parked for review.`)
      }
      if (hn.openSuggestions) {
        lines.push(
          `💡 ${hn.openSuggestions} suggestion(s) awaiting review at kitchen.tarte.com.au/inbox-playbooks (ask Claude to action them).`
        )
      }
      sections.push(lines.join("\n"))
    }
  } catch (e) {
    console.error("[digest] house notes section failed:", e instanceof Error ? e.message : e)
  }

  const handledTotal = handled.rows.reduce((s, r) => s + r.n, 0)
  if (handledTotal) {
    const names: Record<string, string> = {
      archived_noreply: "receipts/notifications archived",
      archived_marketing_cold_outreach: "cold outreach archived",
      archived_no_action: "finished threads archived",
      sent: "replies auto-sent",
      sent_forward: "forwarded to the right team",
    }
    sections.push(
      `🤖 Handled for you in the last 24h (nothing to do):\n` +
        handled.rows
          .map((r) => `  • ${r.n} ${names[r.last_action] ?? r.last_action}`)
          .join("\n")
    )
  }

  const actionCount =
    urgent.rows.length +
    drafts.rows.length +
    needsHuman.rows.length +
    formDrafts.rows.length +
    invoices.rows.length
  // Weekly learning synthesis (Mondays; idempotent) + this week's proposals.
  try {
    const { maybeSynthesizeLearnings, learningDigestSection } = await import("./llm/learning-synthesis.js")
    await maybeSynthesizeLearnings()
    const learn = await learningDigestSection()
    if (learn) sections.push(learn)
  } catch (e) {
    console.error("[learn] digest section failed:", e instanceof Error ? e.message : e)
  }

  // System-health line: broken things go at the TOP so they can't be missed.
  const { healthDigestSection } = await import("./health.js")
  const health = await healthDigestSection().catch(() => "")
  const healthBroken = health.includes("problem")
  const body =
    (healthBroken ? health + "\n\n" : "") +
    (sections.length
      ? sections.join("\n\n")
      : "Nothing needs you today — inbox is clear. 🎉") +
    (healthBroken ? "" : `\n\n${health}`) +
    `\n\n—\nTarte Inbox agent · ${date}`

  // Plain ASCII separator: the em dash was rendering as mojibake in some
  // clients before subject headers were RFC 2047-encoded, and "-" is safer.
  const subject = urgent.rows.length
    ? `Inbox digest ${pretty} - ${urgent.rows.length} URGENT, ${actionCount} to action`
    : `Inbox digest ${pretty} - ${actionCount} to action`

  await sendPlainEmail(
    config().HELLO_MAILBOX,
    subject,
    body,
    config().HELLO_MAILBOX,
    "Tarte Inbox"
  )
  await db().query(
    `INSERT INTO inbox_digest_log (sent_date, summary)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (sent_date) DO NOTHING`,
    [
      date,
      JSON.stringify({
        urgent: urgent.rows.length,
        drafts: drafts.rows.length,
        needs_human: needsHuman.rows.length,
        pipeline: pipeline.rows.length,
        handled_24h: handledTotal,
      }),
    ]
  )
  console.log(`[digest] sent for ${date} (${actionCount} action items)`)
  return { sent: true }
}
