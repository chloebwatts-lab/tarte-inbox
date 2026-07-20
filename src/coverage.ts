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
import { ensureLabel } from "./google/gmail.js"
// Shared domain KNOWLEDGE (who our suppliers are) — not shared processing
// logic; the sentinel's listing and coverage rules stay pipeline-independent.
import { isLikelySupplier } from "./pipeline.js"

// Pipeline-independent noise filter: obvious machine senders never need a reply.
const MACHINE_SENDER =
  /no-?reply|donotreply|do-not-reply|mailer-daemon|postmaster|notification[s]?@|newsletter@|marketing@|alerts?@|receipts?@|billing@|invoice[s]?@squarespace|@docs\.google\.com|@post\.xero\.com/i
// Job-board application relays (hiring platform "conversation-<name>-<id>@"
// senders / "[Action required] New application" subjects). These have their own
// forward-to-work@ queue flow — surfacing 60 of them in the Missed folder would
// drown the real catches (2026-07-20 backfill: 60 of 87 were these).
const JOB_RELAY_SENDER = /^[^<]*<?conversation-[^@]+@/i
const JOB_RELAY_SUBJECT = /^\[action required\] new application/i
// Staff-facing flag labels that mean "a human has been told".
const COVERED_LABEL_NAMES = ["Tarte / Action needed", "Tarte / URGENT"]
// Our own watchdog/digest mail loops back into hello@ — never "unanswered".
// Calendar invite responses (Accepted:/Declined:) are FYIs, not questions.
const OUR_SUBJECT = /^\[tarte inbox\]|^inbox digest |^(accepted|declined|tentative(ly accepted)?):/i

const UNANSWERED_ALERT_HOURS = 4 // the agent acts within minutes; hours = broken
const STALE_DRAFT_HOURS = 48 // system did its part; humans haven't sent
const MAX_LIST = 1000

// The "Missed" folder (Chloe, 2026-07-20): a visible Gmail folder holding every
// customer email our side has NOT actually sent a reply to yet — so the girls
// can see at a glance what slipped through. Broad by design: a pending agent
// draft still counts as "missed" because the customer has received nothing.
// The thread drops out of the folder the moment our reply becomes the newest
// message (we scan it again in place and strip the label). Separate from the
// unread-nagging sweep, which Chloe kept limited to pending drafts.
const MISSED_LABEL_NAME = "Tarte / Missed"
// Short grace so we don't flag mail the agent is still mid-processing (it ticks
// and drafts within minutes; the audit itself only runs hourly).
const MISSED_FOLDER_MIN_HOURS = 1

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
  // The "Missed" folder label. Resolve its id from the existing labels; only
  // create it for real (a live run), so a dry run stays side-effect free.
  let missedLabelId =
    (labelRes.data.labels ?? []).find((l) => l.name === MISSED_LABEL_NAME)?.id ?? ""
  if (!missedLabelId && !opts.dryRun) missedLabelId = await ensureLabel(MISSED_LABEL_NAME)
  let missedAdded = 0
  let missedCleared = 0

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
      // "Noise" = senders that never need a reply from us (automated systems,
      // suppliers, our own loopback mail, internal staff). Same filter the
      // alert buckets below use.
      const noise =
        MACHINE_SENDER.test(from) ||
        OUR_SUBJECT.test(subject) ||
        isLikelySupplier(from) ||
        /@tarte\.com\.au/i.test(from) ||
        JOB_RELAY_SENDER.test(from) ||
        JOB_RELAY_SUBJECT.test(subject)
      const ageHours = (Date.now() - Number(last.internalDate ?? 0)) / 3_600_000

      // --- Missed folder reconciliation (runs for EVERY scanned thread) ---
      // A thread is "missed" while a real customer is the newest message and
      // enough grace has passed that the agent has had its chance. The instant
      // our reply becomes newest (fromUs) it's no longer missed — we scan it in
      // place here and strip the label. Broad by design: a pending draft still
      // counts, because the customer has received nothing.
      const missed = !fromUs && !noise && ageHours > MISSED_FOLDER_MIN_HOURS
      const hasMissedLabel = msgs.some((m) => (m.labelIds ?? []).includes(missedLabelId))
      if (!opts.dryRun) {
        try {
          if (missed && !hasMissedLabel) {
            await g.users.threads.modify({ userId: "me", id, requestBody: { addLabelIds: [missedLabelId] } })
            missedAdded++
          } else if (!missed && hasMissedLabel) {
            await g.users.threads.modify({ userId: "me", id, requestBody: { removeLabelIds: [missedLabelId] } })
            missedCleared++
          }
        } catch (e) {
          console.warn(`[coverage] missed-label reconcile failed for ${id}:`, e instanceof Error ? e.message : e)
        }
      } else if (missed !== hasMissedLabel) {
        if (missed) missedAdded++
        else missedCleared++
      }

      if (fromUs) continue // we answered last — covered
      if (noise) continue
      const hasDraft = msgs.some((m) => (m.labelIds ?? []).includes("DRAFT"))
      const flagged = msgs.some((m) => (m.labelIds ?? []).some((l) => coveredLabelIds.has(l)))
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

  // Second reconcile pass: threads still CARRYING the Missed label that are no
  // longer in the inbox scan. Staff archiving a thread is their natural "dealt
  // with" action (same philosophy as trash = dismissed) — without this pass the
  // label sticks to archived threads forever and the folder silts up with
  // handled mail. Also catches threads that aged past the 30d scan window.
  if (missedLabelId) {
    const scannedSet = new Set(ids)
    try {
      let lp: string | undefined
      do {
        const r = await g.users.threads.list({
          userId: "me",
          labelIds: [missedLabelId],
          maxResults: 100,
          pageToken: lp,
        })
        for (const t of r.data.threads ?? []) {
          if (!t.id || scannedSet.has(t.id)) continue
          if (!opts.dryRun)
            await g.users.threads.modify({ userId: "me", id: t.id, requestBody: { removeLabelIds: [missedLabelId] } })
          missedCleared++
        }
        lp = r.data.nextPageToken ?? undefined
      } while (lp)
    } catch (e) {
      console.warn(`[coverage] missed-label archive sweep failed:`, e instanceof Error ? e.message : e)
    }
  }

  if (opts.dryRun) {
    console.log(
      `[coverage] DRY RUN — ${unanswered.length} unanswered, ${staleDrafts.length} stale drafts, ` +
        `"${MISSED_LABEL_NAME}" would +${missedAdded}/-${missedCleared} (watchdog + labels not touched)`
    )
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
  if (missedAdded || missedCleared)
    console.log(`[coverage] "${MISSED_LABEL_NAME}" folder: +${missedAdded} added, -${missedCleared} cleared`)
  console.log(
    `[coverage] scanned ${scanned}/${ids.length} threads — ${unanswered.length} unanswered, ${staleDrafts.length} stale drafts`
  )
  return { scanned, unanswered, staleDrafts }
}
