// The FOOLPROOF invariant (Chloe, 2026-07-15): NO customer message may sit
// unanswered without a human being told. Every prior incident — the blind-
// inbox bug that hid 250 threads, silent draft failures, skipped states —
// stayed invisible because the health checks watched whether the MACHINE was
// running, not whether the WORK was covered. This sentinel checks the outcome.
//
// Design rules:
//  - Re-derives coverage from Gmail alone: its OWN listing, its OWN pagination,
//    no pipeline code — so a pipeline bug cannot blind it (the tick's 50-thread
//    listing bug would have been caught within the hour by this check).
//  - A thread is COVERED when any of: our reply is the newest message, a draft
//    is pending for staff, or it carries a staff-facing flag label
//    (Action needed / URGENT). Everything else with a human sender and a few
//    hours of age is a MISS → watchdog alert with the exact threads listed.
//  - Secondary check: drafts that have sat unsent for 2+ days (the customer is
//    still waiting even though the system did its part).

import { google, type gmail_v1 } from "googleapis"
import { config } from "./config.js"
import { ensureGoogleAuthed } from "./google/oauth.js"
import { setCheckStatus } from "./health.js"
// Shared domain KNOWLEDGE (who our suppliers are) — not shared processing
// logic; the sentinel's listing and coverage rules stay pipeline-independent.
import { isLikelySupplier } from "./pipeline.js"

// Pipeline-independent noise filter: obvious machine senders never need a reply.
const MACHINE_SENDER =
  /no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|notification[s]?@|newsletter@|marketing@|alerts?@|receipts?@|billing@|invoice[s]?@squarespace|@docs\.google\.com/i
// Staff-facing flag labels that mean "a human has been told".
const COVERED_LABEL_NAMES = ["Tarte / Action needed", "Tarte / URGENT"]
// Our own watchdog/digest mail loops back into hello@ — never "unanswered".
// Calendar invite responses (Accepted:/Declined:) are FYIs, not questions.
const OUR_SUBJECT = /^\[tarte inbox\]|^inbox digest |^(accepted|declined|tentative(ly accepted)?):/i

const UNANSWERED_ALERT_HOURS = 4 // the agent acts within minutes; hours = broken
const STALE_DRAFT_HOURS = 48 // system did its part; humans haven't sent
const MAX_LIST = 1000

interface ThreadVerdict {
  id: string
  from: string
  subject: string
  ageHours: number
}

async function gm(): Promise<gmail_v1.Gmail> {
  const auth = await ensureGoogleAuthed()
  return google.gmail({ version: "v1", auth })
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return (
    msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  )
}

/** Scan the ENTIRE inbox and report the coverage invariant to the watchdog.
 * dryRun computes the report without touching the watchdog (no alert emails). */
export async function runCoverageAudit(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number
  unanswered: ThreadVerdict[]
  staleDrafts: ThreadVerdict[]
}> {
  const g = await gm()
  const hello = config().HELLO_MAILBOX.toLowerCase()

  // Resolve the staff-flag label ids (names live in Gmail, messages carry ids).
  const labelRes = await g.users.labels.list({ userId: "me" })
  const coveredLabelIds = new Set(
    (labelRes.data.labels ?? [])
      .filter((l) => l.name && COVERED_LABEL_NAMES.includes(l.name))
      .map((l) => l.id!)
  )

  // Own pagination, own query. Promotions are excluded to mirror what the
  // agent is responsible for; Gmail-misfiled customers are a separate problem.
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const r = await g.users.threads.list({
      userId: "me",
      q: "in:inbox newer_than:30d -category:promotions",
      maxResults: 100,
      pageToken,
    })
    for (const t of r.data.threads ?? []) if (t.id) ids.push(t.id)
    pageToken = r.data.nextPageToken ?? undefined
  } while (pageToken && ids.length < MAX_LIST)

  const unanswered: ThreadVerdict[] = []
  const staleDrafts: ThreadVerdict[] = []
  let scanned = 0
  for (const id of ids) {
    try {
      const t = await g.users.threads.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      })
      scanned++
      const msgs = t.data.messages ?? []
      const real = msgs.filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
      const last = real[real.length - 1]
      if (!last) continue
      const from = header(last, "From")
      const subject = header(last, "Subject") || "(no subject)"
      const fromUs = from.toLowerCase().includes(hello)
      if (fromUs) continue // we answered last — covered
      if (MACHINE_SENDER.test(from) || OUR_SUBJECT.test(subject) || isLikelySupplier(from)) continue
      // Internal staff mail (shawna@/chloe@/etc. writing to hello@) isn't a
      // customer waiting on us.
      if (/@tarte\.com\.au/i.test(from)) continue
      const hasDraft = msgs.some((m) => (m.labelIds ?? []).includes("DRAFT"))
      const flagged = msgs.some((m) => (m.labelIds ?? []).some((l) => coveredLabelIds.has(l)))
      const ageHours = (Date.now() - Number(last.internalDate ?? 0)) / 3_600_000
      const v: ThreadVerdict = { id, from: from.slice(0, 60), subject: subject.slice(0, 70), ageHours: Math.round(ageHours) }
      if (!hasDraft && !flagged && ageHours > UNANSWERED_ALERT_HOURS) unanswered.push(v)
      else if (hasDraft && ageHours > STALE_DRAFT_HOURS) staleDrafts.push(v)
    } catch (e) {
      console.warn(`[coverage] thread ${id} failed:`, e instanceof Error ? e.message : e)
    }
  }

  const fmt = (list: ThreadVerdict[]): string =>
    list
      .slice(0, 10)
      .map((v) => `${v.from} — "${v.subject}" — waiting ${v.ageHours}h`)
      .join("; ") + (list.length > 10 ? ` (+${list.length - 10} more)` : "")

  if (opts.dryRun) {
    console.log(`[coverage] DRY RUN — ${unanswered.length} unanswered, ${staleDrafts.length} stale drafts (watchdog not updated)`)
    return { scanned, unanswered, staleDrafts }
  }

  await setCheckStatus(
    "coverage",
    unanswered.length === 0,
    unanswered.length
      ? `${unanswered.length} customer message(s) have NO reply, NO draft and NO staff flag: ${fmt(unanswered)}`
      : `all ${scanned} inbox threads covered`
  )
  await setCheckStatus(
    "stale_drafts",
    staleDrafts.length === 0,
    staleDrafts.length
      ? `${staleDrafts.length} draft(s) have sat unsent for ${STALE_DRAFT_HOURS}h+ while the customer waits: ${fmt(staleDrafts)}`
      : undefined
  )
  console.log(
    `[coverage] scanned ${scanned}/${ids.length} threads — ${unanswered.length} unanswered, ${staleDrafts.length} stale drafts`
  )
  return { scanned, unanswered, staleDrafts }
}
