// Watchdog: self-checks the plumbing the whole system depends on and ALERTS
// by email the moment something breaks — with the exact (phone-clickable) fix.
// Born of the Xero-tenants incident: the link broke silently while Chris was
// away, staff only saw symptoms, and the one-click fix went unclicked for days.
//
// Design:
//  - setCheckStatus() persists state per check; an ok->fail transition sends
//    an alert email, fail->ok sends a recovery note, and a still-broken check
//    re-alerts every 24h so it can't be forgotten.
//  - runQuickChecks() covers the cheap checks every 15 min (Google token,
//    Xero link state, digest lateness). Deeper checks (real Xero API call)
//    report in from where they already run (daily keepalive).
//  - The daily digest carries a system-health line so staff see status too.

import { google } from "googleapis"
import { config } from "./config.js"
import { db } from "./db/pool.js"
import { getTokens } from "./db/queries.js"
import { ensureGoogleAuthed } from "./google/oauth.js"
import { sendPlainEmail } from "./google/gmail.js"

const REALERT_HOURS = 24

// What a human should DO when each check fails — plain language, phone-first.
const FIXES: Record<string, string> = {
  google_gmail:
    "Fix (works from a phone): open https://inbox.tarte.com.au/oauth/google/start and sign in as hello@tarte.com.au. If that doesn't clear it within 30 minutes, message Claude in the Tarte session.",
  xero_link:
    "Fix (works from a phone): open https://inbox.tarte.com.au/oauth/xero/start and pick 'Tarte Currumbin Pty Ltd'. Invoicing PDFs keep working either way; this only affects payment matching in Xero.",
  xero_api:
    "Fix (works from a phone): open https://inbox.tarte.com.au/oauth/xero/start and pick 'Tarte Currumbin Pty Ltd'. Invoicing PDFs keep working either way; this only affects payment matching in Xero.",
  ticks:
    "The email agent has stopped processing the inbox. Emails are NOT being lost — they are waiting in Gmail and staff can reply manually as normal. Message Claude in the Tarte session to investigate.",
  digest:
    "The daily digest email did not go out this morning. Staff should work from the 'Tarte / Action needed' label in Gmail until it's back. Message Claude in the Tarte session.",
}

interface HealthRow {
  check_name: string
  ok: boolean
  detail: string | null
  since: Date
  last_alert_at: Date | null
}

function alertRecipients(): string[] {
  return config()
    .ALERT_EMAILS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

async function sendAlert(subject: string, body: string): Promise<void> {
  const c = config()
  for (const to of alertRecipients()) {
    try {
      await sendPlainEmail(to, subject, body, c.HELLO_MAILBOX, "Tarte Inbox Watchdog")
    } catch (e) {
      console.error(`[health] could not send alert to ${to}:`, e instanceof Error ? e.message : e)
    }
  }
}

/** Record a check result. Handles alert/recovery emails on transitions. */
export async function setCheckStatus(name: string, ok: boolean, detail?: string): Promise<void> {
  const { rows } = await db().query<HealthRow>(
    `SELECT check_name, ok, detail, since, last_alert_at FROM inbox_health WHERE check_name = $1`,
    [name]
  )
  const prev = rows[0]
  const wasOk = prev ? prev.ok : true
  if (!prev) {
    await db().query(
      `INSERT INTO inbox_health (check_name, ok, detail, since) VALUES ($1, $2, $3, now())`,
      [name, ok, detail ?? null]
    )
  } else if (wasOk !== ok) {
    await db().query(
      `UPDATE inbox_health SET ok = $2, detail = $3, since = now() WHERE check_name = $1`,
      [name, ok, detail ?? null]
    )
  } else {
    await db().query(`UPDATE inbox_health SET detail = $2 WHERE check_name = $1`, [
      name,
      detail ?? null,
    ])
  }

  if (wasOk && !ok) {
    // ok -> fail: alert immediately.
    await sendAlert(
      `[Tarte Inbox] PROBLEM: ${name}`,
      `The inbox agent detected a problem.\n\n` +
        `What broke: ${name}\n` +
        `Detail: ${detail ?? "(none)"}\n\n` +
        `${FIXES[name] ?? "Message Claude in the Tarte session to investigate."}\n\n` +
        `You'll get another email when this recovers. If it stays broken, this alert repeats daily.`
    )
    await db().query(`UPDATE inbox_health SET last_alert_at = now() WHERE check_name = $1`, [name])
    console.error(`[health] ${name} FAILED: ${detail ?? ""}`)
  } else if (!wasOk && ok) {
    // fail -> ok: all clear.
    await sendAlert(
      `[Tarte Inbox] Resolved: ${name}`,
      `Good news: "${name}" has recovered and everything is running normally again.\n\nNo action needed.`
    )
    console.log(`[health] ${name} recovered`)
  } else if (!ok && prev?.last_alert_at) {
    // still broken: re-alert daily so it can't be forgotten.
    const hours = (Date.now() - new Date(prev.last_alert_at).getTime()) / 3_600_000
    if (hours >= REALERT_HOURS) {
      await sendAlert(
        `[Tarte Inbox] STILL BROKEN (${Math.round(hours)}h): ${name}`,
        `"${name}" has now been broken for ${Math.round(hours)} hours.\n\n` +
          `Detail: ${detail ?? "(none)"}\n\n` +
          `${FIXES[name] ?? "Message Claude in the Tarte session to investigate."}`
      )
      await db().query(`UPDATE inbox_health SET last_alert_at = now() WHERE check_name = $1`, [name])
    }
  }
}

/** Cheap checks, run every 15 min from the scheduler. */
export async function runQuickChecks(): Promise<void> {
  // 1. Google/Gmail: token present AND actually usable (getProfile is free-ish).
  try {
    const auth = await ensureGoogleAuthed()
    const gmail = google.gmail({ version: "v1", auth })
    await gmail.users.getProfile({ userId: "me" })
    await setCheckStatus("google_gmail", true)
  } catch (e) {
    await setCheckStatus(
      "google_gmail",
      false,
      `Gmail access failing: ${e instanceof Error ? e.message : e}. The agent cannot read or draft email until this is fixed.`
    )
  }

  // 2. Xero link state (stored token + tenant list). The deep API check
  //    reports in daily from xeroKeepalive as "xero_api".
  try {
    const t = await getTokens("xero")
    const tenants = (t?.extra?.["tenants"] as unknown[] | undefined) ?? []
    if (!t) {
      await setCheckStatus("xero_link", false, "Xero is not linked at all.")
    } else if (!tenants.length) {
      await setCheckStatus(
        "xero_link",
        false,
        "Xero is linked but the organisation list is empty (the exact failure from the July incident)."
      )
    } else {
      await setCheckStatus("xero_link", true)
    }
  } catch (e) {
    await setCheckStatus("xero_link", false, e instanceof Error ? e.message : String(e))
  }

  // 3. Digest lateness: it should exist by 09:00 Brisbane (gate opens 07:00).
  try {
    const nowB = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Australia/Brisbane",
      hour: "2-digit",
      hour12: false,
    }).format(new Date())
    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*) AS n FROM inbox_digest_log
        WHERE sent_date = (now() AT TIME ZONE 'Australia/Brisbane')::date`
    )
    const sentToday = Number(rows[0]?.n ?? 0) > 0
    if (Number(nowB) >= 9 && !sentToday) {
      await setCheckStatus("digest", false, "No daily digest has gone out today (expected by ~07:00 Brisbane).")
    } else {
      await setCheckStatus("digest", true)
    }
  } catch (e) {
    console.error("[health] digest check failed:", e instanceof Error ? e.message : e)
  }
}

/** Consecutive-failure reporting for the main email tick (from the scheduler). */
let tickFailStreak = 0
export async function recordTickResult(ok: boolean, detail?: string): Promise<void> {
  if (ok) {
    tickFailStreak = 0
    await setCheckStatus("ticks", true).catch(() => {})
    return
  }
  tickFailStreak++
  if (tickFailStreak >= 3) {
    await setCheckStatus(
      "ticks",
      false,
      `${tickFailStreak} inbox ticks in a row have failed. Latest error: ${detail ?? "unknown"}`
    ).catch(() => {})
  }
}

/** One-line health summary for the daily digest. */
export async function healthDigestSection(): Promise<string> {
  const { rows } = await db().query<HealthRow>(
    `SELECT check_name, ok, detail, since, last_alert_at FROM inbox_health ORDER BY check_name`
  )
  const broken = rows.filter((r) => !r.ok)
  if (!broken.length) return "⚙️ System health: all good."
  return (
    `⚙️ SYSTEM HEALTH - ${broken.length} problem(s):\n` +
    broken
      .map((b) => `  • ${b.check_name} (since ${new Date(b.since).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })}): ${b.detail ?? ""}`)
      .join("\n")
  )
}
