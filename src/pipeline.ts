// Per-thread orchestration. Called by the scheduler for each unread inbox thread.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  getThread,
  listInboxThreads,
  listAllInboxThreads,
  listThreadsByLabel,
  listSpamThreads,
  unspamThread,
  ensureLabel,
  applyLabel,
  removeLabel,
  markThreadUnread,
  archiveThread,
  deleteDraft,
  deleteThreadDrafts,
  getThreadDraftBody,
  createInThreadDraft,
  createStandaloneDraft,
  createStandaloneDraftWithThread,
  recentlyRepliedTo,
  threadDraftReadState,
  sendDraft,
  getQueuePreview,
  sendInThreadReply,
  findOurSentReply,
  createForwardDraft,
  sendForward,
  mimeTypeFor,
  type Attachment,
  type ParsedThread,
  type ParsedMessage,
} from "./google/gmail.js"
import { isSlotFree, createEvent, eventsOnDate, upsertReminderEvent, type Venue } from "./google/calendar.js"
import { ensureCombinedCalendar } from "./google/calendar-sync.js"
import { driveReady, uploadInvoicePdf } from "./google/drive.js"
import {
  fetchCustomerHistory,
  renderCustomerHistory,
} from "./google/customer-history.js"
import {
  nbiBookingsForDate,
  nbiBookingsForEmail,
  nbiOverlapCount,
} from "./nbi/ingest.js"
import {
  findOrCreateContact,
  createAuthorisedInvoice,
  getInvoiceOnlineUrl,
  xeroBankMatchReady,
  findIncomingPayment,
} from "./xero/client.js"
import {
  invoiceConfigReady,
  generateDepositInvoice,
} from "./invoice/generate.js"
import {
  extractInvoiceDetails,
  invoiceableNow,
  manuallyInvoiceable,
  buildInvoiceFromExtraction,
  type InvoiceExtraction,
} from "./invoice/from-thread.js"
import { looksLikeDepositPaidClaim, confirmDepositPaid } from "./llm/deposit-paid.js"
import { db } from "./db/pool.js"
import {
  classify,
  CATEGORY_LABELS,
  type Category,
} from "./llm/classifier.js"
import { draft, type DraftResult } from "./llm/drafter.js"
import { extractBooking } from "./llm/booking.js"
import { classifyConfirmation } from "./llm/confirmation.js"
import { dequote } from "./lib/dequote.js"
import { renderFullThread } from "./lib/thread-text.js"
import { maybeAllergenBlock } from "./tk/allergens.js"
import {
  getThread as getThreadRow,
  upsertThread,
  getPlaybook,
  insertBooking,
  getBookingByThread,
  updateBooking,
  recordLearning,
  startRun,
  finishRun,
} from "./db/queries.js"
import { config } from "./config.js"

const VENUE_BY_CATEGORY: Partial<Record<Category, Venue>> = {
  events_tea_garden_functions: "tea_garden",
  events_beach_house_functions: "beach_house",
  events_tea_garden_high_tea: "tea_garden",
}

const MAX_SLOTS_PROPOSED = 3
const SLOT_DURATION_DEFAULT_HOURS = 3
const FUNCTION_DEPOSIT_AUD = 500
// Deposit invoices BCC accounts + Shawna when sent (Shawna 2026-06-15;
// accounts@tarte.com.au confirmed by Chris 2026-06-15).
// Louise (bookkeeper, kilgour1@hotmail.com) is BCC'd on every event invoice
// so she can apply it in Xero against the EVENT date (Chloe 2026-07-28).
const INVOICE_BCC = ["shawna@tarte.com.au", "accounts@tarte.com.au", "kilgour1@hotmail.com"]

/** Subject tag for invoice emails: the EVENT date (what Louise books the
 * revenue against) + the invoice number, e.g. " | EVENT Fri 31 Jul 2026 |
 * TARTE-2026-00016". Kept short and greppable. */
export function invoiceSubjectSuffix(eventDate: string | null | undefined, invoiceNumber: string): string {
  if (!eventDate) return ` | ${invoiceNumber}`
  const label = new Date(`${eventDate}T00:00:00+10:00`).toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  return ` | EVENT ${label} | ${invoiceNumber}`
}

/** Strip any earlier " | EVENT ... | TARTE-..." tag so repeated invoice
 * emails on one thread don't stack suffixes. */
export function stripInvoiceSubjectSuffix(subject: string): string {
  return subject.replace(/ \| (EVENT [^|]+ \| )?TARTE-\d{4}-\d+\s*$/, "")
}
const BALANCE_DAYS_BEFORE_EVENT = 14

// Triage labels — the staff work surface. The deal: anything needing a human
// carries ACTION_LABEL (and URGENT_LABEL when hot); everything the agent
// fully handled is archived out of the inbox with its category label intact.
export const ACTION_LABEL = "Tarte / Action needed"
export const URGENT_LABEL = "Tarte / URGENT"
export const AUTO_HANDLED_LABEL = "Tarte / Auto-handled"
// Invoice lifecycle: "created" when an invoice draft is generated, swapped to
// "sent" once a human actually sends that reply.
export const INVOICE_CREATED_LABEL = "Tarte / Invoice created"
export const INVOICE_SENT_LABEL = "Tarte / Invoice sent"
// Squarespace takeaway high tea orders — labelled + a pickup reminder goes on
// the staff calendar so the kitchen preps for the date.
export const TAKEAWAY_HT_LABEL = "Tarte / Takeaway High Tea"
// Squarespace cake orders — labelled + a colour-coded pickup event goes on the
// combined bookings calendar so cakes sit alongside the high teas & functions.
export const CAKE_ORDER_LABEL = "Tarte / Cake order"
// Table bookings of 12+ guests — foldered so staff can eyeball every large
// group at a glance (these need a set menu Fri-Sun).
export const LARGE_BOOKING_LABEL = "Tarte / 12+ booking"

// Only archive LLM-classified noise when the classifier is sure. Regex-matched
// noreply receipts archive unconditionally.
const ARCHIVE_CONFIDENCE_MIN = 0.75

// --- entry ---

export async function runTick(): Promise<{ seen: number; acted: number }> {
  const runId = await startRun()
  let seen = 0
  let acted = 0
  try {
    const items = await listAllInboxThreads()
    seen = items.length
    // Cheap change-detection: skip threads whose Gmail historyId matches what
    // we stored last time we looked — no per-thread fetch needed. Threads with
    // no stored/changed historyId fall through to a full processThread.
    const { rows: known } = await db().query<{ thread_id: string; last_history_id: string | null }>(
      `SELECT thread_id, last_history_id FROM inbox_threads WHERE thread_id = ANY($1)`,
      [items.map((i) => i.id)]
    )
    const lastHistory = new Map(known.map((r) => [r.thread_id, r.last_history_id]))
    for (const item of items) {
      const stored = lastHistory.get(item.id)
      if (stored && item.historyId && stored === item.historyId) continue
      try {
        const acted_ = await processThread(item.id)
        if (acted_) acted++
      } catch (e) {
        console.error(`[pipeline] thread ${item.id} failed:`, e)
      }
    }
    await finishRun(runId, { threads_seen: seen, threads_acted: acted })
  } catch (e) {
    await finishRun(runId, {
      threads_seen: seen,
      threads_acted: acted,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
  return { seen, acted }
}

// Genuine customer enquiries (especially function/booking requests) occasionally
// get caught in Spam. This sweep rescues ones that look like a real enquiry back
// into the Inbox so the normal pipeline picks them up; obvious junk is left.
const ENQUIRY_HINT =
  /\b(function|event|high tea|hightea|booking|book a|reserve|reservation|table|party|baby shower|hens|birthday|wedding|engagement|catering|cater|cake|private (?:hire|dining|room)|hideout|tea garden|quote|enquir|inquir|availab|how much|price|menu|christmas|celebrat)\b/i

export async function sweepSpam(): Promise<{ scanned: number; rescued: number }> {
  let scanned = 0
  let rescued = 0
  let ids: string[]
  try {
    ids = await listSpamThreads()
  } catch (e) {
    console.error("[spam] list failed:", e instanceof Error ? e.message : e)
    return { scanned: 0, rescued: 0 }
  }
  for (const id of ids) {
    scanned++
    try {
      const thread = await getThread(id)
      const latest = thread.messages[thread.messages.length - 1]
      if (!latest) continue
      // Never rescue obvious automated/cold senders.
      if (NOREPLY_SENDER_PATTERNS.some((p) => p.test(latest.from)) || isLikelySupplier(latest.from)) continue
      const hay = `${latest.subject}\n${latest.bodyText}`
      if (!ENQUIRY_HINT.test(hay)) continue
      await unspamThread(id)
      rescued++
      console.log(`[spam] rescued thread ${id} (${latest.subject.slice(0, 60)})`)
      await processThread(id)
    } catch (e) {
      console.error(`[spam] thread ${id} failed:`, e instanceof Error ? e.message : e)
    }
  }
  if (rescued) console.log(`[spam] swept ${scanned}, rescued ${rescued}`)
  return { scanned, rescued }
}

// --- Squarespace takeaway high tea + cake orders ---
// Order notifications come from no-reply@squarespace.com ("Tarte.: A New Order
// has Arrived (02846)"). High tea orders get a pickup reminder on the staff
// calendar; cake orders get a colour-coded pickup event on the combined
// bookings calendar, alongside the high teas and functions, so the kitchen
// sees every cake due date at a glance.

const SQUARESPACE_ORDER_FROM = /no-reply@squarespace\.com/i
const SQUARESPACE_ORDER_SUBJECT = /new order has arrived \((\d+)\)/i
// Cake pickups wear their own colour so they're instantly distinguishable from
// the default-coloured high teas and functions on the combined calendar.
// "4" = Flamingo (pink) in Google Calendar's event palette.
const CAKE_EVENT_COLOR_ID = "4"

/** Order-item lines mentioning a cake, for the event description. Best-effort
 * — Squarespace layouts vary, so an empty result just means a shorter note. */
function cakeItemLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\bcakes?\b/i.test(l) && !/pickup/i.test(l))
    .slice(0, 4)
}
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

async function maybeHandleTakeawayOrder(
  thread: ParsedThread,
  latest: ParsedMessage
): Promise<boolean> {
  if (!SQUARESPACE_ORDER_FROM.test(latest.from)) return false
  const subj = latest.subject.match(SQUARESPACE_ORDER_SUBJECT)
  if (!subj) return false
  const orderNo = subj[1]!
  const text = latest.bodyText
  // High tea orders take priority (an order with both is prepped as a high
  // tea); cake orders get their own calendar treatment. Anything else (plain
  // bakery/gift card orders) falls through to the automated-receipt archive.
  // "\bcakes?\b" deliberately misses "cheesecake" slices — whole cakes only.
  const isHighTea = /high ?tea/i.test(text)
  const isCake = !isHighTea && /\bcakes?\b/i.test(text)
  if (!isHighTea && !isCake) return false

  // Pickup date arrives in several formats depending on the product:
  //   "Requested Pickup Date: 12/Jul Sunday."      (bakery items)
  //   "Requested Pickup Date: Sat 4th July"        (takeaway high tea)
  //   item field "Date: 7/4/2026"                  (M/D/YYYY, US-style)
  const dm1 = text.match(/Requested Pickup Date:?\s*(\d{1,2})\s*\/\s*([A-Za-z]{3,9})/i)
  const dm2 = text.match(/Requested Pickup Date:?\s*(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})/i)
  const dm3 = text.match(/\bDate:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  // "Requested Pickup Time: 07:00" or item "Time: 10:00:00 AM"
  const timeM =
    text.match(/Requested Pickup Time:?\s*(\d{1,2}):(\d{2})/i) ??
    text.match(/\bTime:?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i)
  // Customer name sits after BILLED TO (optionally PICKUP OPTION), before the
  // street number of the address.
  const nameM = text.match(/BILLED TO:?\s*(?:PICKUP OPTION:?\s*)?([A-Za-z][A-Za-z' .-]*?)(?=\s+\d)/i)
  const customer = nameM?.[1]?.trim() ?? "Customer"

  let day: number | undefined
  let mon: number | undefined
  let yearHint: number | undefined
  if (dm1) {
    day = Number(dm1[1])
    mon = MONTHS[dm1[2]!.slice(0, 3).toLowerCase()]
  } else if (dm2 && MONTHS[dm2[2]!.slice(0, 3).toLowerCase()]) {
    day = Number(dm2[1])
    mon = MONTHS[dm2[2]!.slice(0, 3).toLowerCase()]
  } else if (dm3) {
    // Squarespace item fields are US M/D/YYYY (verified against the footer).
    mon = Number(dm3[1])
    day = Number(dm3[2])
    yearHint = Number(dm3[3])
  }

  let dateStr: string | undefined
  if (day && mon && mon >= 1 && mon <= 12) {
    const todayB = todayBrisbaneStr() // YYYY-MM-DD
    let year = yearHint ?? Number(todayB.slice(0, 4))
    const candidate = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    // No explicit year + date >30d in the past → they mean next year.
    if (!yearHint && candidate < todayB) {
      const past = (Date.parse(todayB) - Date.parse(candidate)) / 86400_000
      if (past > 30) year += 1
    }
    dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  }

  await applyLabel(thread.threadId, isHighTea ? TAKEAWAY_HT_LABEL : CAKE_ORDER_LABEL).catch(() => {})
  const tag = isHighTea ? "takeaway" : "cake"
  if (dateStr) {
    let time: string | undefined
    if (timeM) {
      let hh = Number(timeM[1])
      const ampm = (timeM[3] ?? "").toUpperCase()
      if (ampm === "PM" && hh < 12) hh += 12
      if (ampm === "AM" && hh === 12) hh = 0
      time = `${String(hh).padStart(2, "0")}:${timeM[2]}`
    }
    try {
      if (isHighTea) {
        await upsertReminderEvent({
          calendarId: config().TAKEAWAY_REMINDER_CALENDAR_ID,
          id: `sqorder${orderNo}`,
          summary: `TAKEAWAY HIGH TEA PICKUP — ${customer}${time ? ` ${time}` : ""} (order #${orderNo})`,
          description: `Squarespace order #${orderNo} — takeaway high tea pickup.\nCustomer: ${customer}\n(Auto-created from the order email.)`,
          date: dateStr,
          startTime: time,
        })
      } else {
        // Cakes live on the combined bookings calendar so they sit next to the
        // high teas and functions; fall back to the staff calendar when the
        // token can't reach/create the combined one.
        const calendarId =
          (await ensureCombinedCalendar().catch(() => null)) ??
          config().TAKEAWAY_REMINDER_CALENDAR_ID
        const items = cakeItemLines(text)
        await upsertReminderEvent({
          calendarId,
          id: `sqcake${orderNo}`,
          summary: `CAKE PICKUP — ${customer}${time ? ` ${time}` : ""} (order #${orderNo})`,
          description:
            `Squarespace order #${orderNo} — cake pickup.\nCustomer: ${customer}` +
            (items.length ? `\n${items.join("\n")}` : "") +
            `\n(Auto-created from the order email.)`,
          date: dateStr,
          startTime: time,
          colorId: CAKE_EVENT_COLOR_ID,
        })
      }
      console.log(`[${tag}] order #${orderNo} (${customer}) — pickup on calendar for ${dateStr}${time ? ` ${time}` : ""}`)
    } catch (e) {
      console.error(`[${tag}] calendar event for order #${orderNo} failed:`, e instanceof Error ? e.message : e)
      await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    }
  } else {
    // No pickup date found — flag so a human adds the calendar entry manually.
    await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    console.warn(`[${tag}] order #${orderNo} — no pickup date parsed, flagged`)
  }
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    state: "classified",
    last_action: isHighTea ? "takeaway_ht_order" : "cake_order",
    meta: isHighTea
      ? { takeawayOrder: orderNo, pickupDate: dateStr ?? null, customer }
      : { cakeOrder: orderNo, pickupDate: dateStr ?? null, customer },
  })
  return true
}

/**
 * Staff decided not to respond (deleted the thread, or hit Dismiss on the
 * review queue) — the agent must fully back off: remove our pending draft,
 * drop the action flag, and mark the thread dismissed so no sweep or digest
 * resurrects it.
 */
export async function dismissThread(threadId: string, reason: string): Promise<void> {
  await deleteThreadDrafts(threadId).catch(() => {})
  await removeLabel(threadId, ACTION_LABEL).catch(() => {})
  await upsertThread({
    thread_id: threadId,
    last_message_id: "dismissed",
    state: "dismissed_by_staff",
    last_action: reason,
  })
  console.log(`[pipeline] thread ${threadId} dismissed (${reason}) — draft removed`)
}

export async function dismissTrashedThread(threadId: string): Promise<void> {
  await dismissThread(threadId, "dismissed_trash")
}

// --- Review queue: every pending draft on one mobile page, one tap to send ---
// The single biggest staff time cost is opening each thread in Gmail to review
// a draft. The queue shows customer message + our draft side by side; Send
// fires the existing Gmail draft as-is (a human approves every send — this is
// NOT auto-send, which stays off pending Chris's explicit go-ahead).

export interface QueueItem {
  threadId: string
  category: string | null
  subject: string
  customerFrom: string
  customerSnippet: string
  draftBody: string
  draftedAt: string | null
  flags: string[]
  hasInvoice: boolean
}

export async function listReviewQueue(): Promise<QueueItem[]> {
  const { rows } = await db().query<{
    thread_id: string
    category: string | null
    meta: Record<string, unknown>
  }>(
    `SELECT t.thread_id, t.category, t.meta
       FROM inbox_threads t
      WHERE t.state IN ('drafted','form_drafted')
        AND t.last_processed_at > now() - interval '21 days'
        AND (t.meta->>'queueSentAt') IS NULL
        AND (t.meta->>'queueDraftGoneAt') IS NULL
      ORDER BY t.last_processed_at DESC
      LIMIT 30`
  )
  const items: QueueItem[] = []
  for (const r of rows) {
    try {
      const p = await getQueuePreview(r.thread_id)
      if (!p.hasDraft) continue // sent or deleted since — next tick reconciles
      items.push({
        threadId: r.thread_id,
        category: r.category,
        subject: p.subject,
        customerFrom: p.customerFrom,
        customerSnippet: p.customerSnippet,
        draftBody: (r.meta["draftBody"] as string | undefined) ?? "(open in Gmail to view this draft)",
        draftedAt: (r.meta["draftedAt"] as string | undefined) ?? null,
        flags: Array.isArray(r.meta["flags"]) ? (r.meta["flags"] as string[]) : [],
        hasInvoice: await threadHasInvoice(r.thread_id),
      })
    } catch {
      /* thread gone — skip */
    }
  }
  return items
}

/** Send the pending draft on a thread. Without editedBody it fires the Gmail
 * draft exactly as it stands. With editedBody (queue textarea) it sends the
 * edited text in-thread and removes the old draft — allowed only for drafts
 * without attachments (rebuilding would silently drop an invoice PDF).
 * Human-approved send either way. */
export async function queueSendDraft(
  threadId: string,
  editedBody?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await getThreadRow(threadId)
  if (!row || (row.state !== "drafted" && row.state !== "form_drafted"))
    return { ok: false, error: "this one has already been handled" }
  const draftId = row.meta["draftId"] as string | undefined
  if (!draftId) return { ok: false, error: "no draft recorded for this thread" }

  const originalBody = ((row.meta["draftBody"] as string | undefined) ?? "").trim()
  const wantsEdit = editedBody !== undefined && editedBody.trim() !== "" && editedBody.trim() !== originalBody

  try {
    if (wantsEdit) {
      // Unknown attachment count (older rows) must be treated as "may have
      // one" — rebuilding a draft drops attachments, and losing an invoice
      // PDF or functions pack silently is worse than a Gmail round-trip.
      const rawCount = row.meta["attachmentCount"]
      if (rawCount === undefined || Number(rawCount) > 0)
        return {
          ok: false,
          error: "this draft has (or may have) an attachment — edit it in Gmail so the attachment is kept",
        }
      // Rebuild threading off the conversation tail (same rule as deliver())
      // and address the most recent customer.
      const thread = await getThread(threadId)
      if (!thread.messages.length) return { ok: false, error: "thread not found" }
      const helloMail = config().HELLO_MAILBOX
      let customer = thread.messages[thread.messages.length - 1]!
      for (let i = thread.messages.length - 1; i >= 0; i--) {
        if (!thread.messages[i]!.from.toLowerCase().includes(helloMail.toLowerCase())) {
          customer = thread.messages[i]!
          break
        }
      }
      const tail = thread.messages[thread.messages.length - 1]!
      await sendInThreadReply(
        {
          threadId,
          to: customer.from,
          subject: customer.subject,
          inReplyTo: tail.messageIdHeader ?? "",
          references: tail.references ?? tail.messageIdHeader ?? "",
        },
        editedBody.trim(),
        helloMail,
        "Tarte Team"
      )
      await deleteDraft(draftId)
    } else {
      await sendDraft(draftId)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/404|not found/i.test(msg)) {
      // Draft already sent from Gmail or deleted — reconcile quietly.
      await upsertThread({
        thread_id: threadId,
        last_message_id: row.last_message_id,
        meta: { queueDraftGoneAt: new Date().toISOString() },
      })
      return { ok: false, error: "that draft was already sent or removed in Gmail" }
    }
    return { ok: false, error: msg }
  }
  // Leave state/last_action untouched: the next tick sees our sent reply on a
  // 'drafted' thread and runs the normal capture path (learning with the real
  // edit distance, Invoice sent label, Drive archive). Hide from the queue now.
  await upsertThread({
    thread_id: threadId,
    last_message_id: row.last_message_id,
    meta: { queueSentAt: new Date().toISOString() },
  })
  console.log(`[queue] draft ${wantsEdit ? "edited + " : ""}sent by staff for thread ${threadId}`)
  return { ok: true }
}

// --- "Needs a look": Action-flagged threads with NO pending draft ---
// The other half of the girls' workload (~40/week): urgent items, unmet
// invoice requests, bounces, suppressed forwards. Surfaced with the agent's
// reason note so the queue is the complete to-do list, not just drafts.

export interface NeedsLookItem {
  threadId: string
  category: string | null
  subject: string
  customerFrom: string
  customerSnippet: string
  note: string | null
  forwardTo: string | null // set → offer one-tap "Forward" (e.g. job apps → work@)
  urgent: boolean
}

export async function listNeedsLook(): Promise<NeedsLookItem[]> {
  const ids = await listThreadsByLabel(ACTION_LABEL)
  const items: NeedsLookItem[] = []
  for (const id of ids) {
    try {
      const row = await getThreadRow(id)
      // Drafted threads already show in the drafts section of the queue.
      if (row && (row.state === "drafted" || row.state === "form_drafted")) continue
      if (row?.state === "dismissed_by_staff" || row?.state === "handled_manual") continue
      const p = await getQueuePreview(id)
      items.push({
        threadId: id,
        category: (row?.category as string | null) ?? null,
        subject: p.subject,
        customerFrom: p.customerFrom,
        customerSnippet: p.customerSnippet,
        note: (row?.meta["note"] as string | undefined) ?? null,
        forwardTo:
          row?.meta["forwardSuppressed"] === true
            ? ((row.meta["forwardTo"] as string | undefined) ?? null)
            : null,
        urgent: row?.state === "urgent",
      })
    } catch {
      /* thread gone — skip */
    }
  }
  // Urgent first.
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent)).slice(0, 25)
}

// --- Full-conversation view for the queue (girls' feedback: cards alone
// don't give enough context; they shouldn't need Gmail just to read back).

export interface ThreadViewMessage {
  from: string
  date: Date
  body: string
  ours: boolean
}

export interface ThreadView {
  threadId: string
  subject: string
  messages: ThreadViewMessage[]
  state: string | null
  draftBody: string | null
  canInlineEdit: boolean
  note: string | null
  forwardTo: string | null
  urgent: boolean
}

export async function getQueueThreadView(threadId: string): Promise<ThreadView | null> {
  const thread = await getThread(threadId)
  if (!thread.messages.length) return null
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const row = await getThreadRow(threadId)
  const isDrafted = row?.state === "drafted" || row?.state === "form_drafted"
  const messages: ThreadViewMessage[] = thread.messages.map((m) => ({
    from: m.from,
    date: m.date,
    // Dequote so each bubble is just that message, not the whole chain again.
    body: normalizeForDiff(dequote(m.bodyText)).slice(0, 5000),
    ours: m.from.toLowerCase().includes(helloMail),
  }))
  return {
    threadId,
    subject: thread.messages[0]!.subject,
    messages,
    state: row?.state ?? null,
    draftBody: isDrafted ? ((row?.meta["draftBody"] as string | undefined) ?? null) : null,
    canInlineEdit: isDrafted && Number(row?.meta["attachmentCount"] ?? -1) === 0,
    note: (row?.meta["note"] as string | undefined) ?? null,
    forwardTo:
      row?.meta["forwardSuppressed"] === true
        ? ((row?.meta["forwardTo"] as string | undefined) ?? null)
        : null,
    urgent: row?.state === "urgent",
  }
}

/** Staff hit "Done" — they handled it in Gmail/elsewhere. Clear the flag.
 * No-op for unknown thread ids (never invent rows). */
export async function queueMarkDone(threadId: string): Promise<void> {
  const row = await getThreadRow(threadId)
  if (!row) return
  await removeLabel(threadId, ACTION_LABEL).catch(() => {})
  await upsertThread({
    thread_id: threadId,
    last_message_id: row.last_message_id,
    state: "handled_manual",
    last_action: "queue_done",
  })
  console.log(`[queue] thread ${threadId} marked done by staff`)
}

/** One-tap forward for suppressed forward-only categories (job apps → work@).
 * Human-approved — the girls click it; nothing sends on its own. */
export async function queueForward(
  threadId: string
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
  const row = await getThreadRow(threadId)
  const forwardTo = row?.meta["forwardTo"] as string | undefined
  if (!row || row.meta["forwardSuppressed"] !== true || !forwardTo)
    return { ok: false, error: "this one isn't a pending forward" }
  const thread = await getThread(threadId)
  const latest = thread.messages[thread.messages.length - 1]
  if (!latest) return { ok: false, error: "thread not found" }
  await sendForward(latest, forwardTo, config().HELLO_MAILBOX, "Tarte Inbox")
  await removeLabel(threadId, ACTION_LABEL).catch(() => {})
  await applyLabel(threadId, AUTO_HANDLED_LABEL).catch(() => {})
  await archiveThread(threadId).catch(() => {})
  await upsertThread({
    thread_id: threadId,
    last_message_id: latest.id,
    state: "forwarded",
    last_action: "sent_forward",
    meta: { forwardSuppressed: false, forwardedByQueueAt: new Date().toISOString() },
  })
  console.log(`[queue] thread ${threadId} forwarded to ${forwardTo} by staff`)
  return { ok: true, to: forwardTo }
}

/**
 * Hourly: threads with a pending draft must stay UNREAD until staff action
 * them — a girl opening one (or Gmail syncing a phone) marks it read and it
 * blends back in. Re-assert unread while the draft is still sitting there.
 * Deleted (trashed) threads are the exception: staff dismissed them, back off.
 */
export async function reassertDraftUnread(): Promise<number> {
  const { rows } = await db().query<{ thread_id: string }>(
    `SELECT thread_id FROM inbox_threads
      WHERE state IN ('drafted','form_drafted')
        AND last_processed_at > now() - interval '21 days'
      ORDER BY last_processed_at DESC LIMIT 100`
  )
  let fixed = 0
  for (const r of rows) {
    try {
      const s = await threadDraftReadState(r.thread_id)
      if (s.trashed) {
        await dismissTrashedThread(r.thread_id)
        continue
      }
      if (s.hasDraft && !s.unread) {
        await markThreadUnread(r.thread_id)
        fixed++
      }
    } catch {
      /* thread gone — ignore */
    }
  }
  if (fixed) console.log(`[unread] re-marked ${fixed} drafted thread(s) unread`)
  return fixed
}

const HANDOFF_ADDRESSES = ["shawna@tarte.com.au"] // forwards to these = humans will handle, agent backs off

function threadHandedOff(thread: ParsedThread): boolean {
  // True if any message in the thread has a handoff address in To/Cc.
  // Pattern: customer emails hello@, someone forwards to shawna@, agent backs off.
  return thread.messages.some((m) => {
    const recipients = [...m.to, ...m.cc].map((r) => r.toLowerCase())
    return recipients.some((r) =>
      HANDOFF_ADDRESSES.some((h) => r.includes(h))
    )
  })
}

// Senders we should never reply to. Mostly automated notification systems
// (order confirmations, invoice receipts, system alerts) where a reply
// either goes to /dev/null or back into a ticketing system.
const NOREPLY_SENDER_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /no_reply@/i,
  /notifications?@/i,
  /donotreply@/i,
  /do-not-reply@/i,
  /mailer@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /bounce/i,
  /@ordermentum\.com/i, // supplier ordering platform, automated only
  // NOTE: nowbookit.com is NOT blanket-archived here — a real person (e.g. the
  // NBI account manager) emails from @nowbookit.com and was disappearing. Only
  // the automated NBI notifications are archived, gated by subject below.
  /alerts?@/i,
  /automated@/i,
  /system@/i,
]

// Receipt-style subjects that almost never need a human reply. Targets
// orders@-style supplier addresses that aren't strictly "noreply" but
// still send templated confirmations / invoices.
const RECEIPT_SUBJECT_PATTERNS = [
  /\border confirmation\b/i,
  /\bdelivery confirmation\b/i,
  /\btax invoice\b/i,
  /\bstatement of account\b/i,
  /\breceipt\b/i,
  /\bpayment received\b/i,
  /\bpayment processed\b/i,
  /\binvoice #?\d/i, // "Invoice 12345"
  /^quote #?\d/i,
]

// Known suppliers + their billing domains (from the COGS supplier map). A
// supplier email must NEVER get an auto-reply or a customer-style draft, even
// if classification slips — so this is a hard sender guard, independent of the
// classifier's "suppliers" category.
const SUPPLIER_SENDER_PATTERNS = [
  /@bidfood\./i,
  /pacificfruitandveg\.com\.au/i,
  /@jensens\.net\.au/i,
  /theprovedores\.com\.au/i,
  /@easyvend\.com\.au/i,
  /@pencilpay\.com/i, // Eustralis billing platform
  /@ordermentum\.com/i,
  /son ?of ?a ?bunn/i,
  /global food ?& ?wine|globalfood/i,
  /marrow ?meats/i,
  /\bfermex\b/i,
  /\bjoval\b/i,
  /paramount ?liquor|\bparamount\b/i,
  /produce ?oz/i,
  /gold ?coast ?eggs/i,
  /\bbreadtop\b/i,
  /coastal ?fresh/i,
  /\beustralis\b/i,
]

export function isLikelySupplier(from: string): boolean {
  return SUPPLIER_SENDER_PATTERNS.some((p) => p.test(from))
}

// Clearly-automated NBI system subjects ONLY. Deliberately NOT matching
// "cancellation"/"refund"/"amend" etc. — those appear in real human threads
// (e.g. "Re: Cancellation refund" from the NBI account manager).
const NBI_AUTOMATED_SUBJECT = /\b(daily (booking )?summary|new booking|booking confirm(ation|ed))\b/i
// Bulk/system NBI senders (newsletters, reports, notifications) — archive these.
const NBI_AUTOMATED_SENDER =
  /(noreply|no-reply|donotreply|notifications?|marketing|newsletter|news|reports?|bookings?|hello|info)@nowbookit\.com/i

/** True when a nowbookit.com email is an automated/bulk feed (vs a real person
 *  at NBI). Used to archive only the noise, never a human's reply. */
export function isAutomatedNowBookIt(from: string, subject: string): boolean {
  if (!/@nowbookit\.com/i.test(from)) return false
  return NBI_AUTOMATED_SENDER.test(from) || NBI_AUTOMATED_SUBJECT.test(subject)
}

function isAutomatedReceipt(from: string, subject: string): boolean {
  const lowerFrom = from.toLowerCase()
  if (NOREPLY_SENDER_PATTERNS.some((p) => p.test(lowerFrom))) return true
  // NowBookIt: archive ONLY automated/bulk feeds; a real person at @nowbookit.com
  // stays in the inbox + gets classified/drafted (they were being wrongly archived).
  if (isAutomatedNowBookIt(lowerFrom, subject)) return true
  // Receipt subject + a transactional sender prefix (orders@, billing@, etc.).
  // Deliberately excludes info@/support@/service@ — those are commonly human
  // and a real "Question about invoice #123" from one must not be archived.
  const transactionalSender = /(?:^|<)(orders?|billing|accounts?|invoices?|sales|admin)@/i
  if (
    transactionalSender.test(lowerFrom) &&
    RECEIPT_SUBJECT_PATTERNS.some((p) => p.test(subject))
  ) {
    return true
  }
  return false
}

// --- website contact-form submissions ---
// Squarespace/Wix/Jotform/etc. relay form submissions FROM their own address
// (e.g. form-submission@squarespace.info) with the real customer's email
// buried in the body ("Email: jane@x.com"). Replying to latest.from would
// reach the relay, never the customer — so we parse out the real person and
// reply to THEM in a fresh email.

interface FormSubmission {
  name: string | null
  email: string
  subject: string
  message: string
  interestedIn: string | null
}

const FORM_RELAY_FROM = /squarespace\.info|@(?:wix|jotform|wufoo|typeform|formspree|hubspot)\.com|form-?submission/i

function field(body: string, label: string): string | null {
  const m = body.match(new RegExp(`^\\s*${label}\\s*:?\\s*(.+)$`, "im"))
  return m ? m[1]!.trim() : null
}

export function parseFormSubmission(latest: ParsedMessage): FormSubmission | null {
  const body = latest.bodyText
  const looksLikeForm =
    FORM_RELAY_FROM.test(latest.from) ||
    /sent via form submission/i.test(body) ||
    (/^\s*Name\s*:/im.test(body) &&
      /^\s*Email\s*:/im.test(body) &&
      /^\s*Message\s*:/im.test(body))
  if (!looksLikeForm) return null

  // Real customer email: prefer the "Email:" field, else first address in
  // the body that isn't ours or the relay.
  const emailField = field(body, "Email")
  let email = emailField?.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0] ?? null
  if (!email) {
    const helloMail = config().HELLO_MAILBOX.toLowerCase()
    const all = body.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []
    email =
      all.find(
        (a) =>
          !a.toLowerCase().includes(helloMail) &&
          !FORM_RELAY_FROM.test(a) &&
          !/squarespace|wixpress|noreply/i.test(a)
      ) ?? null
  }
  if (!email) return null

  // The message often spans multiple lines. Walk lines: start at "Message:",
  // collect until a line that begins another known field or relay footer.
  // (A single multiline regex with /m mis-terminates on the first line end.)
  const TERMINATORS =
    /^\s*(?:Interested in|Phone|Create Invoice|Manage Submissions|Does this submission|Sent via|Report it)\b/i
  const lines = body.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => /^\s*Message\s*:/i.test(l))
  let message: string
  if (startIdx >= 0) {
    const collected: string[] = [
      lines[startIdx]!.replace(/^\s*Message\s*:?\s*/i, ""),
    ]
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (TERMINATORS.test(lines[i]!)) break
      collected.push(lines[i]!)
    }
    message = collected.join("\n").trim()
  } else {
    message = body.trim()
  }

  return {
    name: field(body, "Name"),
    email,
    subject: field(body, "Subject") || latest.subject.replace(/^Form Submission[ -]*/i, "").trim() || "your enquiry",
    message,
    interestedIn: field(body, "Interested in"),
  }
}

function firstNameFromFullName(name: string | null): string | undefined {
  if (!name) return undefined
  const first = name.trim().split(/\s+/)[0]
  return first && /^[A-Za-z][A-Za-z'-]*$/.test(first) ? first : undefined
}

/**
 * Handle a parsed website form submission: classify the real message, draft
 * a reply, and create it as a fresh draft TO THE CUSTOMER (not the relay).
 * Always flagged for human review — the recipient was rewritten, so a person
 * sanity-checks it before sending. Never auto-sends.
 */
async function handleFormSubmission(
  thread: ParsedThread,
  latest: ParsedMessage,
  form: FormSubmission
): Promise<boolean> {
  // Duplicate-submission guard: customers often submit the website form twice
  // (or follow up while staff are already replying on a parallel thread). If
  // WE have emailed this customer in the last two weeks, don't draft another
  // reply — label it so staff can eyeball, and note why (Paula Ajani case).
  if (await recentlyRepliedTo(form.email, 14).catch(() => false)) {
    await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: {
        formSubmission: true,
        formEmail: form.email,
        duplicateSkipped: true,
        note: "Form submission from a customer we already replied to in the last 14 days — no draft created (likely duplicate).",
      },
    })
    console.log(`[pipeline] form from ${form.email} skipped — already replied recently (likely duplicate)`)
    return true
  }
  const result = await classify(form.subject, form.email, form.message)
  await applyLabel(thread.threadId, CATEGORY_LABELS[result.category])
  // Tea Garden overlay (same rule as direct email): anything mentioning tea
  // garden / high tea also carries the TG label so it groups visually.
  if (
    !result.category.startsWith("events_tea_garden") &&
    /\btea ?garden\b|\bhigh ?tea\b/i.test(form.subject + " " + form.message)
  ) {
    await applyLabel(thread.threadId, CATEGORY_LABELS.events_tea_garden_high_tea).catch(() => {})
  }

  // Forward-only categories (e.g. job applications → work@). VERY CLEAR job
  // applications auto-forward (Chris 2026-07-13); anything fuzzier is labeled
  // with the one-tap Forward button on the queue. The relay email carries the
  // parsed applicant details, so forwarding it gives work@ everything.
  const fwdPlaybook = await getPlaybook(result.category)
  if (fwdPlaybook?.forward_to) {
    if (result.category === "job_applications" && result.confidence >= AUTO_FORWARD_MIN_CONFIDENCE) {
      console.log(
        `[forward] auto-forwarding clear job application form (conf=${result.confidence.toFixed(2)}) to ${fwdPlaybook.forward_to}`
      )
      const sentId = await sendForward(latest, fwdPlaybook.forward_to, config().HELLO_MAILBOX, "Tarte Inbox")
      await applyLabel(thread.threadId, AUTO_HANDLED_LABEL)
      await archiveThread(thread.threadId)
      await upsertThread({
        thread_id: thread.threadId,
        last_message_id: latest.id,
        state: "forwarded",
        last_action: "sent_forward",
        meta: {
          formSubmission: true,
          formEmail: form.email,
          forwardTo: fwdPlaybook.forward_to,
          sentMessageId: sentId,
        },
      })
      return true
    }
    await applyLabel(thread.threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: {
        formSubmission: true,
        formEmail: form.email,
        forwardTo: fwdPlaybook.forward_to,
        forwardSuppressed: true,
      },
    })
    return true
  }

  // Urgent / no-draft categories: flag, don't draft.
  if (result.category === "urgent_escalation") {
    await applyLabel(thread.threadId, URGENT_LABEL)
    await applyLabel(thread.threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "urgent",
      last_action: "flagged_urgent",
      meta: { formEmail: form.email, formName: form.name },
    })
    return true
  }
  if (
    result.category === "needs_human" ||
    result.category === "accounts_invoices" ||
    result.category === "marketing_cold_outreach" ||
    result.category === "no_action"
  ) {
    await applyLabel(thread.threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { formEmail: form.email, formName: form.name, formSubmission: true },
    })
    return true
  }

  const playbook = await getPlaybook(result.category)
  const allergenBlock = await maybeAllergenBlock(form.subject + "\n" + form.message)
  // Cross-chain context: this form may be from a customer already mid-thread
  // elsewhere — pull their other threads so we give consistent, true answers.
  const formHistory = await fetchCustomerHistory(form.email, thread.threadId)
  const formHistoryBlock = renderCustomerHistory(formHistory)
  const extras: Array<{ role: "user" | "assistant"; content: string }> = [
    {
      role: "user",
      content:
        `This enquiry arrived through our WEBSITE CONTACT FORM. Reply to the customer (${form.name ?? form.email}) directly and naturally — do not mention forms, Squarespace, or how it reached us.` +
        (form.interestedIn ? ` They selected interest: "${form.interestedIn}".` : ""),
    },
  ]
  if (formHistoryBlock) extras.push({ role: "user", content: formHistoryBlock })
  if (allergenBlock) extras.push({ role: "user", content: allergenBlock })

  const d = await draft({
    category: result.category,
    playbook,
    threadHistory: [
      { from: `${form.name ?? "Customer"} <${form.email}>`, date: latest.date, text: form.message },
    ],
    customerName: firstNameFromFullName(form.name),
    customExtras: extras,
  })
  if (!d.body) return await flagDraftFailure(thread, latest, result.category)

  // ALWAYS attach the functions pack on a function/event reply, even via the
  // website-form path (Shawna 2026-06-15) — customers should see the options.
  const formAttachments =
    playbook?.default_attachment_paths?.length
      ? await loadAttachments(playbook.default_attachment_paths)
      : []
  // Draft IN the form thread (addressed To: the real customer), NOT as a
  // detached standalone draft. Standalone drafts were invisible on the form
  // thread, so staff thought the agent never replied (Lyn/Leina/Kay) and the
  // drafts piled up disconnected (Shawna). In-thread + To:customer = visible
  // on the "Action needed" thread AND reaches the customer when sent.
  const draftId = await createInThreadDraft(
    {
      threadId: thread.threadId,
      to: form.email,
      subject: form.subject,
      inReplyTo: latest.messageIdHeader ?? "",
      references: latest.references ?? latest.messageIdHeader ?? "",
    },
    d.body,
    config().HELLO_MAILBOX,
    "Tarte Team",
    formAttachments
  )
  await applyLabel(thread.threadId, ACTION_LABEL)
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    state: "form_drafted",
    last_action: "drafted",
    meta: {
      formSubmission: true,
      formEmail: form.email,
      formName: form.name,
      category: result.category,
      draftId,
      draftBody: d.body,
      draftedAt: new Date().toISOString(),
      flags: d.flags,
      attachmentCount: formAttachments.length,
    },
  })
  console.log(`[pipeline] form submission -> in-thread draft to ${form.email} (${result.category})`)
  return true
}

export async function processThread(
  threadId: string,
  opts: { force?: boolean } = {}
): Promise<boolean> {
  const thread = await getThread(threadId)
  if (!thread.messages.length) return false
  // Staff deleted it → they've decided not to respond. Back off entirely
  // (no classify, no draft, no labels) and clean up anything we left on it.
  if (thread.messages[thread.messages.length - 1]!.labelIds.includes("TRASH")) {
    await dismissTrashedThread(threadId)
    return false
  }
  // When forced, pretend the latest customer message is the one to reply to
  // — even if our team has already replied. Used for /thread/:id/redraft so
  // we can test the agent's drafting after a prompt change without waiting
  // for new customer activity.
  let latest = thread.messages[thread.messages.length - 1]!
  if (opts.force) {
    const helloMail = config().HELLO_MAILBOX.toLowerCase()
    // Walk back to the most recent customer-authored message
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const m = thread.messages[i]!
      if (!m.from.toLowerCase().includes(helloMail)) {
        latest = m
        break
      }
    }
  }
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const fromUs = latest.from.toLowerCase().includes(helloMail)

  const existing = await getThreadRow(threadId)

  // Edit-capture: if the latest message is ours, and we previously drafted, log diff.
  if (fromUs && existing?.last_action === "drafted") {
    await captureEdit(thread, existing.meta)
    // Staff sent the reply — if it carried an invoice, archive the PDF to Drive
    // and flip the invoice label from "created" to "sent".
    await archiveThreadInvoicesToDrive(threadId).catch((e) =>
      console.error("[drive] archive-on-send error:", e instanceof Error ? e.message : e)
    )
    if (await threadHasInvoice(threadId)) {
      await applyLabel(threadId, INVOICE_SENT_LABEL).catch(() => {})
      await removeLabel(threadId, INVOICE_CREATED_LABEL).catch(() => {})
    }
    // Staff replied — their action item is done, clear the flag.
    await removeLabel(threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "sent_by_human",
      last_action: "captured_edit",
    })
    return true
  }

  // Skip if nothing new since last time — but persist the freshest historyId
  // so the paginated tick can skip this thread without re-fetching it.
  if (existing?.last_message_id === latest.id) {
    if (thread.historyId && existing.last_history_id !== thread.historyId) {
      await upsertThread({
        thread_id: threadId,
        last_message_id: latest.id,
        last_history_id: thread.historyId,
      })
    }
    return false
  }

  // Guest reply on a dine-in booking-confirmation thread: record the ack (and
  // any high-tea answer) before normal classification. Plain acknowledgements
  // are archived here and the pipeline stops; questions and change requests
  // fall through to the classifier/drafter like any other customer email.
  if (!fromUs) {
    try {
      const { handleConfirmationReply } = await import("./nbi/confirmations.js")
      if (await handleConfirmationReply(threadId)) {
        await upsertThread({
          thread_id: threadId,
          last_message_id: latest.id,
          last_history_id: thread.historyId ?? null,
          category: "bookings_dine_in",
          state: "ack_recorded",
          last_action: "booking_ack",
        })
        return true
      }
    } catch (e) {
      console.error(
        `[confirm] ack intercept failed for ${threadId}:`,
        e instanceof Error ? e.message : e
      )
    }
  }

  // Skip if no human-facing message (e.g. fully internal/automated)
  if (fromUs) {
    // If staff replied to a thread we'd flagged for them (needs_human etc.),
    // their job is done — clear the flag and mark it handled so the digest
    // stops listing it.
    const wasFlagged =
      (existing?.state === "classified" && existing?.last_action === "labeled") ||
      existing?.state === "urgent"
    if (wasFlagged) await removeLabel(threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: wasFlagged ? "sent_by_human" : undefined,
      last_action: "skipped_outbound",
    })
    return false
  }

  // Website contact-form submission? The real customer is in the body, not
  // the From header — handle specially so the reply reaches the person, not
  // the form relay (Squarespace etc.).
  const form = parseFormSubmission(latest)
  if (form) {
    return await handleFormSubmission(thread, latest, form)
  }
  // Looked like a form (relay sender) but we couldn't find a customer email
  // — never reply to the relay; flag for a human.
  if (FORM_RELAY_FROM.test(latest.from)) {
    await applyLabel(threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { formRelayUnparsed: true },
    })
    return true
  }

  // Strip quoted blocks + auto-mailer boilerplate from the latest body
  // before classifying — keeps signal clean when the customer replied into
  // a NBI confirmation or Outlook-quoted chain.
  const cleanLatestBody = dequote(latest.bodyText)

  // --- classify ---
  const result = await classify(latest.subject, latest.from, cleanLatestBody)
  const label = CATEGORY_LABELS[result.category]
  await applyLabel(threadId, label)

  // Overlay rule (staff request): ANYTHING tea-garden related also carries the
  // Tea Garden label so it groups visually — even when routing-wise it's an
  // existing-booking change or general enquiry. Label only; routing unchanged.
  if (
    !result.category.startsWith("events_tea_garden") &&
    /\btea ?garden\b|\bhigh ?tea\b/i.test(latest.subject + " " + cleanLatestBody)
  ) {
    await applyLabel(threadId, CATEGORY_LABELS.events_tea_garden_high_tea).catch(() => {})
  }

  await upsertThread({
    thread_id: threadId,
    last_message_id: latest.id,
    last_history_id: thread.historyId ?? null,
    category: result.category,
    confidence: result.confidence,
    state: "classified",
    last_action: "labeled",
    meta: { rationale: result.rationale },
  })

  // Customer says they've paid the deposit → acknowledge + attach a balance
  // invoice (human verifies the payment before sending). Runs before any
  // handed-off / already-invoiced routing so the claim isn't swallowed.
  try {
    if (await maybeHandleDepositPaid(thread, latest)) return true
  } catch (e) {
    console.error("[invoice] deposit-paid handling failed:", e instanceof Error ? e.message : e)
  }

  // Handed off to a human via forward (e.g. shawna@tarte.com.au)?
  // Label only, don't draft — EXCEPT for invoicing: forwarding a "please
  // invoice" to Shawna is exactly the cue to auto-build the deposit invoice,
  // so the agent does that (as a draft for review) instead of backing off.
  if (threadHandedOff(thread)) {
    const venue = VENUE_BY_CATEGORY[result.category]
    if (
      venue &&
      invoiceConfigReady() &&
      looksLikeInvoiceStage(renderFullThread(thread.messages)) &&
      !(await threadHasInvoice(threadId))
    ) {
      try {
        if (
          await maybeAutoInvoice(
            thread,
            latest,
            venue,
            result.category,
            renderFullThread(thread.messages)
          )
        ) {
          return true
        }
      } catch (e) {
        console.error(
          "[invoice] handed-off auto-invoice failed:",
          e instanceof Error ? e.message : e
        )
      }
    }
    // The customer wrote AGAIN on a thread a human owns — backing off silently
    // made these vanish for days (Miranda, 2026-07-15: 5 days before her
    // Saturday event). Flag the queue so the owner is reminded; still no draft.
    await applyLabel(threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "handed_off",
      last_action: "skipped_handoff",
      meta: { note: "Customer replied on a handed-off thread — the teammate it was handed to needs to respond." },
    })
    return true
  }

  // Delivery failures are NOT noise: if an email we sent bounced, a customer
  // is waiting on a reply that never arrived. Flag loudly, never archive.
  if (
    /mailer-daemon|postmaster/i.test(latest.from) &&
    /deliver|undeliver|fail|return|bounce/i.test(latest.subject)
  ) {
    await applyLabel(threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "delivery_failure",
      last_action: "flagged_bounce",
    })
    return true
  }

  // Squarespace TAKEAWAY HIGH TEA + CAKE orders: label + pickup event on the
  // calendar. Must run before the automated-receipt archive below (the order
  // email comes from no-reply@squarespace.com).
  if (await maybeHandleTakeawayOrder(thread, latest)) return true

  // Automated notification (noreply, order confirmation, statement, etc).
  // No human at the other end — label, archive out of the inbox.
  if (isAutomatedReceipt(latest.from, latest.subject)) {
    await archiveThread(threadId)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "noreply_skipped",
      last_action: "archived_noreply",
    })
    return true
  }

  // Concluded threads and cold outreach: archive when the classifier is
  // confident. Category label stays on for audit; a new reply from the
  // sender brings the thread straight back into the inbox.
  if (
    (result.category === "no_action" ||
      result.category === "marketing_cold_outreach") &&
    result.confidence >= ARCHIVE_CONFIDENCE_MIN
  ) {
    await archiveThread(threadId)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "auto_archived",
      last_action: "archived_" + result.category,
    })
    return true
  }

  // Urgent: never drafted, never archived. Flag loudly and stop.
  if (result.category === "urgent_escalation") {
    await applyLabel(threadId, URGENT_LABEL)
    await applyLabel(threadId, ACTION_LABEL)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "urgent",
      last_action: "flagged_urgent",
    })
    return true
  }

  // --- forward-only categories (e.g. job_applications → work@) ---
  // If the playbook has a forward_to address, we forward the original
  // email to that team instead of drafting a reply to the sender.
  const earlyPlaybook = await getPlaybook(result.category)
  if (earlyPlaybook?.forward_to) {
    return await forwardThread(thread, latest, result.category, earlyPlaybook.forward_to, result.confidence)
  }

  // --- function-flow shortcut for events ---
  const venue = VENUE_BY_CATEGORY[result.category]
  if (venue && result.category !== "events_tea_garden_high_tea") {
    return await handleFunctionEnquiry(thread, latest, venue, result.category)
  }

  // --- label-only categories: no draft, but staff need to see them ---
  if (
    result.category === "marketing_cold_outreach" ||
    result.category === "no_action"
  ) {
    // Low-confidence noise (confident noise was archived above). Leave in
    // the inbox with its category label, no action flag.
    return true
  }
  if (
    result.category === "needs_human" ||
    result.category === "accounts_invoices" ||
    // Suppliers: never auto-reply or draft a customer-style reply. Label so
    // staff see it and handle directly (price lists, statements, order
    // confirmations, a rep's question — none of these want an agent reply).
    result.category === "suppliers"
  ) {
    await applyLabel(threadId, ACTION_LABEL)
    return true
  }

  const playbook = earlyPlaybook
  const customerEmailAddr = extractEmail(latest.from)
  const history = customerEmailAddr
    ? await fetchCustomerHistory(customerEmailAddr, thread.threadId)
    : []
  const historyBlock = renderCustomerHistory(history)

  // For existing-booking emails, give the drafter the customer's actual
  // upcoming NBI reservations so the reply speaks to their booking instead
  // of asking them to repeat details. The agent can't modify NBI itself, so
  // the draft always waits for a human (who actions the change, then sends).
  const extras: Array<{ role: "user" | "assistant"; content: string }> = []
  if (historyBlock) extras.push({ role: "user", content: historyBlock })
  if (result.category === "bookings_existing" && customerEmailAddr) {
    const nbi = await nbiBookingsForEmail(customerEmailAddr)
    if (nbi.length) {
      extras.push({
        role: "user",
        content:
          `Customer's upcoming bookings on file (internal — never mention "Now Book It" or booking refs to the customer):\n` +
          nbi
            .map(
              (b) =>
                `  • ${b.booking_date} ${b.booking_time.slice(0, 5)} — ${b.service}, ${b.pax} pax, status ${b.status}` +
                (b.notes ? ` (notes: ${b.notes})` : "")
            )
            .join("\n") +
          `\nUse the matching booking's details in the reply. A teammate will action the requested change in the booking system before sending, so write as if the change is done.`,
      })
    } else {
      extras.push({
        role: "user",
        content:
          "No booking was found on file for this email address. Don't tell the customer we can't find them — write the reply naturally and a teammate will verify the booking before sending.",
      })
    }
  }

  const allergenBlock = await maybeAllergenBlock(latest.subject + "\n" + cleanLatestBody)
  if (allergenBlock) extras.push({ role: "user", content: allergenBlock })

  const d = await draft({
    category: result.category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: firstName(latest.from),
    customExtras: extras.length ? extras : undefined,
  })
  if (!d.body) return await flagDraftFailure(thread, latest, result.category)

  return await deliver(thread, latest, d, result.category, playbook)
}

// --- helpers ---

function toHistoryItem(m: ParsedMessage): { from: string; date: Date; text: string } {
  // Dequote so the drafter doesn't see NBI confirmation boilerplate or
  // Outlook-quoted chain noise. Keeps the prompt focused on real content.
  // Read the WHOLE message — never lose info to truncation (Chris's rule).
  // 16k chars ~= 3000 words; covers any realistic email in full.
  return { from: m.from, date: m.date, text: dequote(m.bodyText).slice(0, 16000) }
}

function firstName(from: string): string | undefined {
  // "Jane Smith <jane@x.com>" → "Jane"; "jane@x.com" → undefined
  const nameMatch = from.match(/^([^<]+)</)
  if (!nameMatch) return undefined
  const name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "")
  const first = name.split(/\s+/)[0]
  return first && /^[A-Za-z][A-Za-z'-]*$/.test(first) ? first : undefined
}

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/)
  return (m ? m[1] : from)!.trim().toLowerCase()
}

const ATTACHMENTS_DIR = "/app/attachments"

async function loadAttachments(paths: string[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const p of paths) {
    try {
      // Reject paths that escape the attachments dir
      if (p.includes("..") || p.startsWith("/")) {
        console.warn(`[attachments] skip unsafe path: ${p}`)
        continue
      }
      const full = join(ATTACHMENTS_DIR, p)
      const data = await readFile(full)
      out.push({
        filename: p.split("/").pop() ?? p,
        contentType: mimeTypeFor(p),
        data,
      })
    } catch (e) {
      console.warn(
        `[attachments] failed to load ${p}:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  return out
}

function isOurFirstReply(thread: ParsedThread, helloMail: string): boolean {
  // True when none of the prior messages in the thread are from us.
  const lc = helloMail.toLowerCase()
  // Exclude the latest message (it's the incoming we're about to reply to)
  const prior = thread.messages.slice(0, -1)
  return !prior.some((m) => m.from.toLowerCase().includes(lc))
}

/**
 * Forward the latest incoming message to a target address (e.g. work@) and
 * skip drafting a reply to the original sender. Auto-sends when both
 * playbook.auto_send and ENABLE_AUTO_SEND are true; otherwise drafts.
 */
// Job applications are internal routing (hello@ → work@), not a customer
// reply, and Chris explicitly authorised auto-forwarding the VERY CLEAR ones
// (2026-07-13). "Very clear" = classifier confidence at/above this bar;
// anything fuzzier keeps the one-tap Forward button on the queue.
const AUTO_FORWARD_MIN_CONFIDENCE = 0.9

async function forwardThread(
  thread: ParsedThread,
  latest: ParsedMessage,
  category: Category,
  forwardTo: string,
  confidence = 0
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  const pb = await getPlaybook(category)
  const clearJobApplication =
    category === "job_applications" && confidence >= AUTO_FORWARD_MIN_CONFIDENCE
  const shouldAutoSend =
    (config().ENABLE_AUTO_SEND && pb?.auto_send === true) || clearJobApplication
  if (shouldAutoSend) {
    if (clearJobApplication)
      console.log(
        `[forward] auto-forwarding clear job application (conf=${confidence.toFixed(2)}) to ${forwardTo}`
      )
    const sentId = await sendForward(
      latest,
      forwardTo,
      helloMail,
      "Tarte Inbox"
    )
    // Fully handled: the receiving team owns it now. Out of hello@'s inbox.
    await applyLabel(thread.threadId, AUTO_HANDLED_LABEL)
    await archiveThread(thread.threadId)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "forwarded",
      last_action: "sent_forward",
      meta: { forwardTo, sentMessageId: sentId, category },
    })
    return true
  }
  // Auto-send OFF: do NOT create a forward draft. Unsent forward drafts just
  // pile up disconnected from the original thread (Shawna 2026-06-15) and the
  // receiving team never gets them anyway. Just label the thread so staff see
  // it; once auto-send is enabled, forwards actually send to the team.
  await applyLabel(thread.threadId, ACTION_LABEL)
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    state: "classified",
    last_action: "labeled",
    meta: { forwardTo, category, forwardSuppressed: true },
  })
  return true
}

async function deliver(
  thread: ParsedThread,
  latest: ParsedMessage,
  d: DraftResult,
  category: Category,
  playbook: Awaited<ReturnType<typeof getPlaybook>>,
  opts: {
    extraAttachments?: Attachment[]
    bcc?: string[]
    invoiceCreated?: boolean
    // Appended to the reply subject (e.g. the EVENT-date tag on invoice
    // emails). Any earlier tag is stripped first so they never stack.
    subjectSuffix?: string
  } = {}
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  // Last-line guard: never address a reply to a no-reply / relay sender that
  // slipped past classification into a drafting category. Flag for a human
  // instead of creating a draft that would bounce or hit a ticket queue.
  if (NOREPLY_SENDER_PATTERNS.some((p) => p.test(latest.from))) {
    await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { suppressedNoreplyReply: true, category },
    })
    return true
  }
  // Hard supplier guard: never auto-reply/draft to a known supplier sender,
  // even if it slipped into a drafting category. Label for a human instead.
  if (isLikelySupplier(latest.from)) {
    await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { suppressedSupplierReply: true, category },
    })
    return true
  }
  // Thread the reply off the LAST message in the conversation (not necessarily
  // the one we're answering) so Gmail places it at the bottom in order. Replying
  // In-Reply-To an older message makes Gmail nest the reply mid-thread — the
  // "out of order" bug. We still address the customer (latest.from).
  const tail = thread.messages[thread.messages.length - 1] ?? latest
  const ctx = {
    threadId: thread.threadId,
    to: latest.from,
    bcc: opts.bcc,
    subject: opts.subjectSuffix
      ? stripInvoiceSubjectSuffix(latest.subject) + opts.subjectSuffix
      : latest.subject,
    inReplyTo: tail.messageIdHeader ?? latest.messageIdHeader ?? "",
    references:
      tail.references ?? tail.messageIdHeader ?? latest.references ?? latest.messageIdHeader ?? "",
  }
  // Only attach default files on our FIRST reply in the thread.
  const defaultAttachments =
    playbook?.default_attachment_paths?.length && isOurFirstReply(thread, helloMail)
      ? await loadAttachments(playbook.default_attachment_paths)
      : []
  const attachments = [...defaultAttachments, ...(opts.extraAttachments ?? [])]

  const shouldAutoSend =
    config().ENABLE_AUTO_SEND &&
    playbook?.auto_send === true &&
    d.confidence >= (playbook?.min_confidence ?? 0.95) &&
    !d.flags.includes("needs_human") &&
    !d.flags.includes("needs_floor_layout_check") &&
    // Allergen/dietary answers always get human eyes before sending, no
    // matter how trusted the category becomes.
    !d.flags.includes("allergen_question")

  if (shouldAutoSend) {
    // Sweep any superseded pending drafts so staff don't find a stale draft
    // under an already-answered thread.
    await deleteThreadDrafts(thread.threadId)
    const sentId = await sendInThreadReply(
      ctx,
      d.body,
      helloMail,
      "Tarte Team",
      attachments
    )
    // Replied in full — archive so staff never touch it. A customer reply
    // brings the thread back into the inbox automatically.
    await applyLabel(thread.threadId, AUTO_HANDLED_LABEL)
    await archiveThread(thread.threadId)
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "auto_sent",
      last_action: "sent",
      meta: {
        sentMessageId: sentId,
        sentBody: d.body,
        draftConfidence: d.confidence,
        flags: d.flags,
        attachmentCount: attachments.length,
      },
    })
    return true
  }
  // Supersede any pending drafts we made earlier in this thread (e.g. the
  // customer followed up before staff sent one) so Gmail never accumulates
  // stale duplicates.
  await deleteThreadDrafts(thread.threadId)
  const draftId = await createInThreadDraft(
    ctx,
    d.body,
    helloMail,
    "Tarte Team",
    attachments
  )
  await applyLabel(thread.threadId, ACTION_LABEL)
  if (opts.invoiceCreated) await applyLabel(thread.threadId, INVOICE_CREATED_LABEL).catch(() => {})
  // Keep the thread UNREAD so the pending draft surfaces for staff (bold + in
  // the unread count) rather than being read past.
  await markThreadUnread(thread.threadId).catch(() => {})
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    last_history_id: thread.historyId ?? null,
    state: "drafted",
    last_action: "drafted",
    meta: {
      draftId,
      draftedAt: new Date().toISOString(),
      draftBody: d.body,
      draftConfidence: d.confidence,
      flags: d.flags,
      category,
      attachmentCount: attachments.length,
    },
  })
  return true
}

/**
 * In-thread draft for a follow-up nudge (used by followups.ts). Always a
 * draft — nudges are never auto-sent — and flags the thread for staff.
 */
export async function deliverNudgeDraft(
  thread: ParsedThread,
  lastCustomer: ParsedMessage,
  body: string
): Promise<void> {
  const helloMail = config().HELLO_MAILBOX
  // Thread off the conversation tail so the nudge lands at the bottom in order.
  const tail = thread.messages[thread.messages.length - 1] ?? lastCustomer
  const draftId = await createInThreadDraft(
    {
      threadId: thread.threadId,
      to: lastCustomer.from,
      subject: lastCustomer.subject,
      inReplyTo: tail.messageIdHeader ?? lastCustomer.messageIdHeader ?? "",
      references:
        tail.references ?? tail.messageIdHeader ?? lastCustomer.references ?? lastCustomer.messageIdHeader ?? "",
    },
    body,
    helloMail,
    "Tarte Team"
  )
  await applyLabel(thread.threadId, ACTION_LABEL)
  await markThreadUnread(thread.threadId).catch(() => {})
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: thread.messages[thread.messages.length - 1]!.id,
    state: "drafted",
    last_action: "drafted",
    meta: {
      draftId,
      draftedAt: new Date().toISOString(),
      draftBody: body,
      nudge: true,
    },
  })
}

/**
 * Empty draft body (LLM hiccup / parse fail) must never leave a thread
 * silently stalled. Flag it for a human and surface it in the digest.
 */
async function flagDraftFailure(
  thread: ParsedThread,
  latest: ParsedMessage,
  category: Category
): Promise<boolean> {
  await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    last_history_id: thread.historyId ?? null,
    state: "draft_failed",
    last_action: "draft_failed",
    meta: { category, draftFailedAt: new Date().toISOString() },
  })
  console.warn(`[pipeline] empty draft for thread ${thread.threadId} (${category}) — flagged for human`)
  return true
}

// --- auto-invoice from a finalised thread ---

// Cheap pre-gate so we only spend an LLM extraction on threads that actually
// look like they've reached the deposit/invoice stage.
const INVOICE_STAGE_RE =
  /\binvoice|\bdeposit\b|secure (?:the|your|my|this)|lock (?:it|in|this|that)|save[- ]?the[- ]?date|final numbers|put a hold|hold (?:on|the|this|it)|confirm[^.]{0,25}(?:date|booking|numbers)/i

function looksLikeInvoiceStage(text: string): boolean {
  return INVOICE_STAGE_RE.test(text)
}

async function threadHasInvoice(threadId: string): Promise<boolean> {
  const { rows } = await db().query(
    `SELECT 1 FROM inbox_invoices WHERE thread_id = $1 AND invoice_number <> 'PENDING' LIMIT 1`,
    [threadId]
  )
  return rows.length > 0
}

async function threadHasInvoiceKind(threadId: string, kind: "standard" | "balance"): Promise<boolean> {
  const { rows } = await db().query(
    `SELECT 1 FROM inbox_invoices WHERE thread_id = $1 AND kind = $2 AND invoice_number <> 'PENDING' LIMIT 1`,
    [threadId, kind]
  )
  return rows.length > 0
}

/**
 * A customer reply says they've paid the deposit → draft a warm acknowledgement
 * with a BALANCE invoice (remaining amount) attached, mark the booking
 * deposit_paid, and flag a human to verify the payment landed before sending.
 * Never auto-sends and never treats the claim as proof of payment. Idempotent:
 * once a balance invoice exists for the thread it won't fire again.
 * Returns true when it handled the thread (caller should stop).
 */
async function maybeHandleDepositPaid(thread: ParsedThread, latest: ParsedMessage): Promise<boolean> {
  if (!invoiceConfigReady()) return false
  // Needs an existing deposit invoice, and no balance invoice yet.
  if (!(await threadHasInvoiceKind(thread.threadId, "standard"))) return false
  if (await threadHasInvoiceKind(thread.threadId, "balance")) return false

  const latestText = dequote(latest.bodyText)
  if (!looksLikeDepositPaidClaim(latestText)) return false
  if (!(await confirmDepositPaid(latestText))) return false

  // Rebuild from the deposit invoice's stored detail (the agreed numbers).
  const { rows } = await db().query<{ editable: InvoiceExtraction | null; invoice_number: string }>(
    `SELECT editable, invoice_number FROM inbox_invoices
      WHERE thread_id = $1 AND kind = 'standard' AND editable IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [thread.threadId]
  )
  const x = rows[0]?.editable
  const depositInvoiceNumber = rows[0]?.invoice_number ?? null
  if (!x) {
    // We can't safely build a balance invoice without the agreed detail —
    // flag for a human rather than guessing.
    await applyLabel(thread.threadId, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "classified",
      last_action: "labeled",
      meta: { depositPaidClaim: true, balanceInvoiceMissingDetail: true },
    })
    return true
  }

  const today = todayBrisbaneStr()
  const booking = await getBookingByThread(thread.threadId)
  const gross = x.add_ons.reduce(
    (s, a) => s + a.unit_price * (a.per_person && x.guests ? x.guests : 1),
    (x.per_person_price ?? 0) * (x.guests ?? 0)
  )
  const depositPaid = Math.round((gross * (x.deposit_pct ?? 50)) / 100 * 100) / 100

  // Try to VERIFY the payment against the Xero bank feed (best-effort). The
  // customer's word alone is never treated as proof — if we can't match it, we
  // flag a human and don't claim receipt. Customers routinely pay either the
  // deposit OR the whole invoice in one hit — check the full total first so a
  // full payer is never mis-billed for a "remaining balance" they don't owe.
  let verified = false
  let matchedTxnId: string | null = null
  let matchedRef: string | null = null
  let paidAmount = depositPaid
  const bankMatchReady = await xeroBankMatchReady()
  if (bankMatchReady) {
    try {
      const match =
        (await findIncomingPayment({
          amount: gross,
          reference: depositInvoiceNumber,
          customerName: x.customer_name,
        })) ??
        (await findIncomingPayment({
          amount: depositPaid,
          reference: depositInvoiceNumber,
          customerName: x.customer_name,
        }))
      if (match) {
        verified = true
        matchedTxnId = match.bankTransactionId
        matchedRef = match.reference
        paidAmount = match.total
      }
    } catch (e) {
      console.error("[xero] bank match failed:", e instanceof Error ? e.message : e)
    }
  }
  const balance = Math.max(0, Math.round((gross - paidAmount) * 100) / 100)
  const paidInFull = verified && balance <= 0

  if (booking)
    await updateBooking(booking.id, { state: paidInFull ? "paid" : "deposit_paid" }).catch(() => {})

  // Record the payment claim/verification (idempotent per thread+invoice).
  await db()
    .query(
      `INSERT INTO inbox_payments (thread_id, invoice_number, booking_id, amount, status, matched_txn_id, matched_reference, verified_at, confirmation_drafted_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, ${verified ? "now()" : "NULL"}, now()
        WHERE NOT EXISTS (SELECT 1 FROM inbox_payments WHERE thread_id = $1 AND confirmation_drafted_at IS NOT NULL)`,
      [
        thread.threadId,
        depositInvoiceNumber,
        booking?.id ?? null,
        paidAmount,
        verified ? "verified" : bankMatchReady ? "unmatched" : "claimed",
        matchedTxnId,
        matchedRef,
      ]
    )
    .catch((e) => console.error("[payments] record failed:", e instanceof Error ? e.message : e))

  // Only a bank-verified amount goes on the invoice as money received — an
  // unverified claim keeps the pct-derived deposit presentation as before.
  const built = await buildInvoiceFromExtraction(
    verified ? { ...x, amount_paid: paidAmount } : x,
    {
      bookingId: booking?.id ?? null,
      threadId: thread.threadId,
      todayBrisbane: today,
      kind: "balance",
    }
  )

  // Use the function category that fits the thread (for playbook voice).
  const category: Category = "events_beach_house_functions"
  const playbook = await getPlaybook(category)
  const instruction = paidInFull
    ? `The customer has paid and we have CONFIRMED their payment of $${paidAmount.toFixed(2)} in our bank records — that settles the invoice IN FULL. Nothing is owing.\n` +
      `Attached is their PAID invoice (${built.invoiceNumber}) showing paid in full, for their records.\n` +
      `Drafting rule: warm, short reply. Thank them, confirm we've received their payment in full and there's nothing more to pay, and that the attached copy is for their records. Don't re-list every line. A few sentences.`
    : verified
    ? `The customer says they paid their deposit AND we have CONFIRMED a matching payment in our bank records — so you can warmly confirm we've received it.\n` +
      `Attached is their BALANCE invoice (${built.invoiceNumber}) for the remaining $${balance.toFixed(2)}, due before the event.\n` +
      `Drafting rule: warm, short reply. Confirm we've received their deposit with thanks, and that the attached invoice covers the remaining balance payable before the day. Don't re-list every line. A few sentences.`
    : `The customer says they have PAID their deposit, but we have NOT yet confirmed it landed (a teammate will check the bank).\n` +
      `Attached is their BALANCE invoice (${built.invoiceNumber}) for the remaining $${balance.toFixed(2)}, due before the event.\n` +
      `Drafting rule: warm, short reply. Thank them, say we'll confirm the deposit has come through, and that the attached invoice covers the remaining balance payable before the day. Don't claim we've received it yet. Don't re-list every line. A few sentences.`
  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: x.customer_name ?? firstName(latest.from),
    customExtras: [{ role: "user", content: instruction }],
  })
  if (!d.body) return await flagDraftFailure(thread, latest, category)
  if (!d.flags.includes("needs_human")) d.flags.push("needs_human")
  const safeName = (x.customer_name ?? "customer").replace(/[^A-Za-z0-9 ]/g, "").trim()
  await deliver(thread, latest, d, category, playbook, {
    bcc: INVOICE_BCC, invoiceCreated: true,
    extraAttachments: [
      {
        filename: `${built.invoiceNumber} - ${safeName}${paidInFull ? " (Paid)" : " (Balance)"}.pdf`,
        contentType: "application/pdf",
        data: built.pdf,
      },
    ],
  })
  console.log(
    `[invoice] ${paidInFull ? "paid-in-full" : "balance"} invoice ${built.invoiceNumber} drafted for thread ${thread.threadId} ($${balance} owing) — payment ${verified ? "VERIFIED in Xero" : "unverified (human to check)"}`
  )
  return true
}

// Fields a staff member can tweak on the quick-amend form. Everything else
// (add-ons, booking type) is preserved from the original extraction.
export interface InvoiceEdits {
  customer_name?: string
  customer_email?: string
  event_type?: string
  package_name?: string
  venue_space?: string
  per_person_price?: number
  guests?: number
  event_date?: string // YYYY-MM-DD
  time_label?: string
  dietaries?: string
  deposit_pct?: number
  // Money received against the invoice: 0 clears it, a partial amount shows
  // "Payment received" + remaining balance, >= total renders PAID IN FULL.
  amount_paid?: number
  // Shortcut: set amount_paid to the recalculated invoice total.
  paid_in_full?: boolean
  // When provided, REPLACES the stored extras wholesale — the form submits the
  // full desired list, so staff can change, remove, or add lines freely.
  add_ons?: Array<{ description: string; unit_price: number; per_person: boolean }>
}

export interface InvoiceRecord {
  invoice_number: string
  kind: "standard" | "balance"
  thread_id: string | null
  booking_id: number | null
  customer_name: string | null
  editable: InvoiceExtraction | null
}

export interface InvoiceListRow {
  invoice_number: string
  kind: "standard" | "balance"
  customer_name: string | null
  amount: string
  created_at: string
  editable: boolean
  payment_status: string | null
}

/** All invoices, most recent first, for the browse page. */
export async function listInvoices(): Promise<InvoiceListRow[]> {
  const { rows } = await db().query<InvoiceListRow>(
    `SELECT i.invoice_number, i.kind, i.customer_name, i.amount, i.created_at,
            (i.editable IS NOT NULL) AS editable,
            p.status AS payment_status
       FROM inbox_invoices i
       LEFT JOIN LATERAL (
         SELECT status FROM inbox_payments WHERE thread_id = i.thread_id ORDER BY id DESC LIMIT 1
       ) p ON true
      WHERE i.invoice_number <> 'PENDING'
      ORDER BY i.id DESC`
  )
  return rows
}

/**
 * Manually create a brand-new invoice from staff-entered fields (the
 * /invoice/new form) — no email thread required. Generates the branded PDF,
 * creates a standalone DRAFT to the customer with it attached (BCC accounts +
 * Shawna), links the invoice to the new draft's thread so on-send capture,
 * Drive archive and the edit form all work, and labels it.
 */
export async function createManualInvoice(fields: {
  customer_name: string
  customer_email: string
  event_type?: string
  package_name?: string
  venue_space?: string
  event_date?: string
  time_label?: string
  guests?: number
  per_person_price?: number
  deposit_pct?: number
  dietaries?: string
}): Promise<{ ok: true; invoiceNumber: string } | { ok: false; error: string }> {
  if (!invoiceConfigReady()) return { ok: false, error: "invoice config not set" }
  if (!fields.customer_name || !fields.customer_email)
    return { ok: false, error: "customer name and email are required" }
  const hasMoney = (fields.per_person_price ?? 0) > 0 && (fields.guests ?? 0) > 0
  if (!hasMoney) return { ok: false, error: "guests and price per person are required" }

  const x: InvoiceExtraction = {
    booking_type: "private_hire",
    customer_confirmed: true,
    ready_to_invoice: true,
    customer_name: fields.customer_name,
    customer_email: fields.customer_email,
    event_type: fields.event_type ?? null,
    package_name: fields.package_name ?? null,
    venue_space: fields.venue_space ?? null,
    per_person_price: fields.per_person_price ?? null,
    guests: fields.guests ?? null,
    event_date: fields.event_date ?? null,
    time_label: fields.time_label ?? null,
    dietaries: fields.dietaries ?? null,
    deposit_pct: fields.deposit_pct ?? 50,
    add_ons: [],
    confidence: 1,
    missing: [],
  }
  const today = todayBrisbaneStr()
  const built = await buildInvoiceFromExtraction(x, {
    bookingId: null,
    threadId: "",
    todayBrisbane: today,
    kind: "standard",
  })
  const deposit = Math.round(((fields.per_person_price! * fields.guests! * (fields.deposit_pct ?? 50)) / 100) * 100) / 100
  const firstNameOnly = fields.customer_name.split(/\s+/)[0]
  const body =
    `Hi ${firstNameOnly},\n\n` +
    `Thank you for booking with us${fields.event_date ? ` for ${fields.event_date}` : ""} — please find your deposit invoice attached. ` +
    `Paying the ${fields.deposit_pct ?? 50}% deposit ($${deposit.toFixed(2)}) secures your date, and final numbers and dietaries can be confirmed closer to the day.\n\n` +
    `Kind Regards,\nTarte Management`
  const safeName = fields.customer_name.replace(/[^A-Za-z0-9 ]/g, "").trim()
  const { threadId } = await createStandaloneDraftWithThread(
    fields.customer_email,
    `Your booking with Tarte${invoiceSubjectSuffix(fields.event_date, built.invoiceNumber)}`,
    body,
    config().HELLO_MAILBOX,
    "Tarte Team",
    [
      {
        filename: `${built.invoiceNumber} - ${safeName}.pdf`,
        contentType: "application/pdf",
        data: built.pdf,
      },
    ],
    INVOICE_BCC
  )
  await db().query(`UPDATE inbox_invoices SET thread_id = $1 WHERE invoice_number = $2`, [
    threadId,
    built.invoiceNumber,
  ])
  await upsertThread({
    thread_id: threadId,
    last_message_id: "manual_invoice",
    state: "drafted",
    last_action: "drafted",
    meta: { manualInvoice: true, invoiceNumber: built.invoiceNumber },
  })
  await applyLabel(threadId, INVOICE_CREATED_LABEL).catch(() => {})
  await applyLabel(threadId, ACTION_LABEL).catch(() => {})
  console.log(`[invoice] manually created ${built.invoiceNumber} for ${fields.customer_email} (thread ${threadId})`)
  return { ok: true, invoiceNumber: built.invoiceNumber }
}

/** Load an invoice (with its editable detail) for the quick-amend form. */
export async function getInvoiceForEdit(invoiceNumber: string): Promise<InvoiceRecord | null> {
  const { rows } = await db().query<InvoiceRecord>(
    `SELECT invoice_number, kind, thread_id, booking_id, customer_name, editable
       FROM inbox_invoices WHERE invoice_number = $1 LIMIT 1`,
    [invoiceNumber]
  )
  return rows[0] ?? null
}

/**
 * Rebuild an invoice PDF from staff-edited fields and refresh the in-thread
 * draft so the corrected PDF replaces the old one. The email text is preserved;
 * only the attachment changes. Returns the new balance/total summary.
 */
export async function regenerateInvoiceFromEdits(
  invoiceNumber: string,
  edits: InvoiceEdits
): Promise<{ ok: true; invoiceNumber: string } | { ok: false; error: string }> {
  const rec = await getInvoiceForEdit(invoiceNumber)
  if (!rec) return { ok: false, error: "invoice not found" }
  if (!rec.editable) return { ok: false, error: "this invoice has no stored detail to edit" }
  if (!rec.thread_id) return { ok: false, error: "invoice is not linked to a thread" }
  if (!invoiceConfigReady()) return { ok: false, error: "invoice config not set" }

  // Merge edits over the stored extraction (skip blank/unchanged fields).
  const base = rec.editable
  const x: InvoiceExtraction = {
    ...base,
    customer_name: edits.customer_name ?? base.customer_name,
    customer_email: edits.customer_email ?? base.customer_email,
    event_type: edits.event_type ?? base.event_type,
    package_name: edits.package_name ?? base.package_name,
    venue_space: edits.venue_space ?? base.venue_space,
    per_person_price: edits.per_person_price ?? base.per_person_price,
    guests: edits.guests ?? base.guests,
    event_date: edits.event_date ?? base.event_date,
    time_label: edits.time_label ?? base.time_label,
    dietaries: edits.dietaries ?? base.dietaries,
    deposit_pct: edits.deposit_pct ?? base.deposit_pct,
    amount_paid: edits.amount_paid ?? base.amount_paid,
    add_ons: edits.add_ons ?? base.add_ons,
  }
  if (edits.paid_in_full) {
    const gross = x.add_ons.reduce(
      (s, a) => s + a.unit_price * (a.per_person && x.guests ? x.guests : 1),
      (x.per_person_price ?? 0) * (x.guests ?? 0)
    )
    x.amount_paid = Math.round(gross * 100) / 100
  }

  const thread = await getThread(rec.thread_id)
  if (!thread.messages.length) return { ok: false, error: "thread not found" }
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  // Reply onto the most recent customer-authored message.
  let latest = thread.messages[thread.messages.length - 1]!
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (!m.from.toLowerCase().includes(helloMail)) {
      latest = m
      break
    }
  }

  const today = todayBrisbaneStr()
  const built = await buildInvoiceFromExtraction(x, {
    bookingId: rec.booking_id,
    threadId: rec.thread_id,
    todayBrisbane: today,
    kind: rec.kind,
  })

  // If the thread ALSO has the sibling invoice (e.g. the deposit was edited but
  // a balance invoice was already issued, or vice versa), rebuild it too with
  // the same corrected numbers so the two never drift apart. The attachment on
  // the draft is the invoice the staffer was actually editing.
  const siblingKind = rec.kind === "standard" ? "balance" : "standard"
  if (await threadHasInvoiceKind(rec.thread_id, siblingKind)) {
    await buildInvoiceFromExtraction(x, {
      bookingId: rec.booking_id,
      threadId: rec.thread_id,
      todayBrisbane: today,
      kind: siblingKind,
    }).catch((e) => console.error("[invoice] sibling rebuild failed:", e instanceof Error ? e.message : e))
  }

  // Preserve the existing email text; just swap the attachment. Read the LIVE
  // Gmail draft first — staff hand-edit draft wording, and regenerating the
  // PDF must never throw those words away (Chloe, 2026-07-15).
  const row = await getThreadRow(rec.thread_id)
  const prevBody =
    (await getThreadDraftBody(rec.thread_id)) ??
    (row?.meta?.["draftBody"] as string | undefined) ??
    ""
  const body =
    prevBody ||
    `Hi ${x.customer_name ?? "there"},\n\nPlease find your updated invoice attached.\n\nKind Regards,\nTarte Management`
  const category = (row?.category as Category | undefined) ?? "events_beach_house_functions"
  const playbook = await getPlaybook(category)
  const d: DraftResult = { body, confidence: 0.5, flags: ["needs_human"] }
  const safeName = (x.customer_name ?? "customer").replace(/[^A-Za-z0-9 ]/g, "").trim()
  const suffix = rec.kind === "balance" ? " (Balance)" : ""
  await deliver(thread, latest, d, category, playbook, {
    bcc: INVOICE_BCC, invoiceCreated: true,
    subjectSuffix: invoiceSubjectSuffix(x.event_date, built.invoiceNumber),
    extraAttachments: [
      {
        filename: `${built.invoiceNumber} - ${safeName}${suffix}.pdf`,
        contentType: "application/pdf",
        data: built.pdf,
      },
    ],
  })
  console.log(`[invoice] regenerated ${built.invoiceNumber} from staff edits (thread ${rec.thread_id})`)
  return { ok: true, invoiceNumber: built.invoiceNumber }
}

/** Archive a copy of every not-yet-archived invoice for a thread to Google
 * Drive. Called when a drafted invoice reply is actually sent by a human — the
 * sent copy is the one worth keeping. Idempotent (drive_file_id guards it) and
 * non-fatal: if Drive isn't authed yet, the rows are left for the hourly sweep
 * to retry once Chris re-auths. */
async function archiveThreadInvoicesToDrive(threadId: string): Promise<void> {
  if (!(await driveReady())) return
  const { rows } = await db().query<{
    id: number
    invoice_number: string
    customer_name: string | null
    pdf_bytes: Buffer | null
  }>(
    `SELECT id, invoice_number, customer_name, pdf_bytes
       FROM inbox_invoices
      WHERE thread_id = $1 AND drive_file_id IS NULL AND pdf_bytes IS NOT NULL`,
    [threadId]
  )
  for (const inv of rows) {
    try {
      const name = inv.customer_name ? `${inv.invoice_number} - ${inv.customer_name}.pdf` : `${inv.invoice_number}.pdf`
      const fileId = await uploadInvoicePdf({ filename: name, bytes: inv.pdf_bytes! })
      await db().query(
        `UPDATE inbox_invoices SET drive_file_id = $1, drive_uploaded_at = now() WHERE id = $2`,
        [fileId, inv.id]
      )
      console.log(`[drive] archived invoice ${inv.invoice_number} -> ${fileId}`)
    } catch (e) {
      console.error(`[drive] failed to archive invoice ${inv.invoice_number}:`, e instanceof Error ? e.message : e)
    }
  }
}

/** Hourly sweep: retry Drive archival for invoices whose draft has already been
 * sent by a human but weren't uploaded at the time (e.g. Drive not yet authed).
 * Scoped to sent_by_human threads so still-pending drafts aren't archived early. */
export async function sweepInvoiceDriveUploads(): Promise<number> {
  if (!(await driveReady())) return 0
  const { rows } = await db().query<{ thread_id: string }>(
    `SELECT DISTINCT i.thread_id
       FROM inbox_invoices i
       JOIN inbox_threads t ON t.thread_id = i.thread_id
      WHERE i.drive_file_id IS NULL
        AND i.pdf_bytes IS NOT NULL
        AND t.state = 'sent_by_human'`
  )
  for (const r of rows) await archiveThreadInvoicesToDrive(r.thread_id)
  return rows.length
}

/**
 * When a function thread has reached the invoicing stage with all final
 * details agreed, generate the Tarte deposit invoice from the thread and
 * draft a reply with it attached. Always flagged for human review; never
 * auto-sends. Returns false if not ready (caller continues normal flow).
 */
async function maybeAutoInvoice(
  thread: ParsedThread,
  latest: ParsedMessage,
  venue: Venue,
  category: Category,
  fullText: string
): Promise<boolean> {
  if (!invoiceConfigReady()) return false
  if (!looksLikeInvoiceStage(fullText)) return false
  if (await threadHasInvoice(thread.threadId)) return false
  const today = todayBrisbaneStr()
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
  }).format(new Date())
  const x = await extractInvoiceDetails(thread, today, weekday)
  // From-header fallback — the address is often only in the headers.
  if (!x.customer_email) x.customer_email = extractEmail(latest.from) || null
  if (!invoiceableNow(x)) return false
  return await composeAndDeliverInvoice(thread, latest, category, x, today)
}

/** Build the invoice, draft the locking-in reply, deliver with the PDF
 *  attached + BCC. Shared by the auto path and the Make-Invoice label. */
async function composeAndDeliverInvoice(
  thread: ParsedThread,
  latest: ParsedMessage,
  category: Category,
  x: Awaited<ReturnType<typeof extractInvoiceDetails>>,
  today: string
): Promise<boolean> {
  const booking = await getBookingByThread(thread.threadId)
  const built = await buildInvoiceFromExtraction(x, {
    bookingId: booking?.id ?? null,
    threadId: thread.threadId,
    todayBrisbane: today,
  })
  const total = x.add_ons.reduce(
    (s, a) => s + a.unit_price * (a.per_person && x.guests ? x.guests : 1),
    (x.per_person_price ?? 0) * (x.guests ?? 0)
  )
  const deposit = Math.round((total * (x.deposit_pct ?? 50)) / 100 * 100) / 100
  const playbook = await getPlaybook(category)
  const dateLabel = x.event_date
    ? new Date(`${x.event_date}T00:00:00+10:00`).toLocaleDateString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : "the agreed date"
  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: x.customer_name ?? firstName(latest.from),
    customExtras: [
      {
        role: "user",
        content:
          `The booking is now CONFIRMED and the deposit invoice (${built.invoiceNumber}) is ATTACHED to this email as a PDF.\n` +
          `Date: ${dateLabel}; Time: ${x.time_label ?? "as agreed"}; Guests: ${x.guests ?? "?"}; Package: ${[x.package_name, x.venue_space].filter(Boolean).join(" in ")}.\n` +
          `Deposit to pay now: ${x.deposit_pct ?? 50}% = $${deposit.toFixed(2)}.\n` +
          `Drafting rule: warm, short reply. Thank them for confirming the details, say their deposit invoice is attached and paying the deposit secures the date, and that final numbers/dietaries can be confirmed closer to the day. Don't re-list every line. Keep it to a few sentences.`,
      },
    ],
  })
  if (!d.body) return await flagDraftFailure(thread, latest, category)
  // Invoices always get human eyes before sending.
  if (!d.flags.includes("needs_human")) d.flags.push("needs_human")
  const safeName = (x.customer_name ?? "customer").replace(/[^A-Za-z0-9 ]/g, "").trim()
  await deliver(thread, latest, d, category, playbook, {
    // BCC accounts + Shawna + Louise so the sent invoice copies them in.
    bcc: INVOICE_BCC, invoiceCreated: true,
    subjectSuffix: invoiceSubjectSuffix(x.event_date, built.invoiceNumber),
    extraAttachments: [
      {
        filename: `${built.invoiceNumber} - ${safeName}.pdf`,
        contentType: "application/pdf",
        data: built.pdf,
      },
    ],
  })
  console.log(`[invoice] built ${built.invoiceNumber} for thread ${thread.threadId} (${x.guests}pax, $${total})`)
  return true
}

// --- on-demand invoicing via the "Make Invoice" Gmail label ---
// Staff apply this label to any function thread; the agent builds the invoice
// (relaxed gate — a human asked for it) and drafts the reply with the PDF
// attached + BCC. Answers Chris's "how do I invoice now instead of Shawna".
export const MAKE_INVOICE_LABEL = "Tarte / Make Invoice"

export async function runInvoiceRequests(): Promise<{ processed: number }> {
  if (!invoiceConfigReady()) return { processed: 0 }
  const ids = await listThreadsByLabel(MAKE_INVOICE_LABEL)
  let processed = 0
  const today = todayBrisbaneStr()
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
  }).format(new Date())
  for (const id of ids) {
    try {
      const thread = await getThread(id)
      if (!thread.messages.length) {
        await removeLabel(id, MAKE_INVOICE_LABEL).catch(() => {})
        continue
      }
      const helloMail = config().HELLO_MAILBOX.toLowerCase()
      let customerMsg = thread.messages[thread.messages.length - 1]!
      for (let i = thread.messages.length - 1; i >= 0; i--) {
        if (!thread.messages[i]!.from.toLowerCase().includes(helloMail)) {
          customerMsg = thread.messages[i]!
          break
        }
      }
      const existingRow = await getThreadRow(id)
      const category = ((existingRow?.category as Category) ?? "events_tea_garden_functions")
      if (await threadHasInvoice(id)) {
        // Already invoiced — staff applying Make-Invoice again means they want
        // it REBUILT with the latest thread details (used to silently no-op,
        // which read as "invoice creation isn't working").
        await processInvoiceRebuild(id)
        await removeLabel(id, MAKE_INVOICE_LABEL).catch(() => {})
        processed++
        continue
      }
      // Staff explicitly asked for an invoice — give the extractor the
      // customer's OTHER threads too, since agreed prices/deposits often
      // live in an earlier chain (the Bianca Zorn failure, 2026-07-24).
      const customerAddr = extractEmail(customerMsg.from) || ""
      const history = customerAddr ? await fetchCustomerHistory(customerAddr, id).catch(() => []) : []
      const x = await extractInvoiceDetails(thread, today, weekday, renderCustomerHistory(history))
      // From-header fallback — the address is often only in the headers.
      if (!x.customer_email) x.customer_email = customerAddr || null
      if (manuallyInvoiceable(x)) {
        await composeAndDeliverInvoice(thread, customerMsg, category, x, today)
      } else {
        // Not enough to build a correct invoice — flag what's missing instead
        // of guessing.
        await applyLabel(id, ACTION_LABEL).catch(() => {})
        await upsertThread({
          thread_id: id,
          last_message_id: thread.messages[thread.messages.length - 1]!.id,
          state: "classified",
          last_action: "labeled",
          meta: {
            invoiceRequestUnmet: true,
            missing: x.missing,
            note: "Make-Invoice requested but couldn't auto-build — missing price/date/numbers. Add the details to the thread and re-apply the label, or invoice manually.",
          },
        })
        console.warn(`[invoice] make-invoice on ${id} unmet — missing: ${x.missing.join(", ")}`)
      }
      await removeLabel(id, MAKE_INVOICE_LABEL).catch(() => {})
      processed++
    } catch (e) {
      console.error(`[invoice] make-invoice ${id} failed:`, e instanceof Error ? e.message : e)
      await removeLabel(id, MAKE_INVOICE_LABEL).catch(() => {})
    }
  }
  return { processed }
}

// --- on-demand invoice AMENDMENT via the "Update Invoice" Gmail label ---
// Numbers change (e.g. guest count) AFTER an invoice was sent. A staffer applies
// this label to the thread; the agent re-reads the thread's latest agreed
// details, rebuilds the existing invoice(s) for that thread (deposit + balance
// stay in sync), and drops the corrected version as a draft to review + send.
// Entirely Gmail-native — no website needed.
export const UPDATE_INVOICE_LABEL = "Tarte / Update Invoice"

/**
 * Build-or-rebuild the invoice(s) for one thread from its latest agreed
 * details. Shared by the Update-Invoice label, the Make-Invoice label when an
 * invoice already exists (staff expect a refresh, not a silent no-op), and
 * one-off ops. Returns what happened.
 */
export async function processInvoiceRebuild(
  id: string
): Promise<"rebuilt" | "built" | "unmet" | "empty"> {
  const today = todayBrisbaneStr()
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
  }).format(new Date())
  const thread = await getThread(id)
  if (!thread.messages.length) return "empty"
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  let customerMsg = thread.messages[thread.messages.length - 1]!
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (!thread.messages[i]!.from.toLowerCase().includes(helloMail)) {
      customerMsg = thread.messages[i]!
      break
    }
  }
  const existingRow = await getThreadRow(id)
  const category = (existingRow?.category as Category) ?? "events_tea_garden_functions"

  // Which invoice kinds already exist on this thread?
  const kindsRes = await db().query<{ kind: "standard" | "balance" }>(
    `SELECT DISTINCT kind FROM inbox_invoices WHERE thread_id = $1 AND invoice_number <> 'PENDING'`,
    [id]
  )
  const kinds = kindsRes.rows.map((r) => r.kind)

  // Same cross-thread context as the Make-Invoice path — rebuilds must see
  // details agreed in the customer's other chains too.
  const rbAddr = extractEmail(customerMsg.from) || ""
  const rbHistory = rbAddr ? await fetchCustomerHistory(rbAddr, id).catch(() => []) : []
  const x = await extractInvoiceDetails(thread, today, weekday, renderCustomerHistory(rbHistory))
  // The customer's address lives in the From header, not always in the body
  // text the extractor reads — don't let a missing body email block invoicing.
  if (!x.customer_email) x.customer_email = rbAddr || null
  // Payments aren't part of the thread extraction — carry forward what staff
  // or the bank match already recorded so a rebuild never "unpays" an invoice.
  const prior = await db().query<{ editable: InvoiceExtraction | null }>(
    `SELECT editable FROM inbox_invoices
      WHERE thread_id = $1 AND editable IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [id]
  )
  const priorPaid = prior.rows[0]?.editable?.amount_paid
  if (typeof priorPaid === "number" && priorPaid > 0) x.amount_paid = priorPaid

  // No invoice yet → build the first one.
  if (kinds.length === 0) {
    if (manuallyInvoiceable(x)) {
      await composeAndDeliverInvoice(thread, customerMsg, category, x, today)
      return "built"
    }
    await applyLabel(id, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: id,
      last_message_id: thread.messages[thread.messages.length - 1]!.id,
      state: "classified",
      last_action: "labeled",
      meta: {
        invoiceUpdateUnmet: true,
        missing: x.missing,
        note: "Invoice requested but couldn't auto-build — add the missing details (price, date, numbers) to the thread and re-apply the label.",
      },
    })
    console.warn(`[invoice] build on ${id} unmet — missing: ${x.missing.join(", ")}`)
    return "unmet"
  }

  // Need usable numbers to rebuild a correct invoice.
  if (!manuallyInvoiceable(x)) {
    await applyLabel(id, ACTION_LABEL).catch(() => {})
    await upsertThread({
      thread_id: id,
      last_message_id: thread.messages[thread.messages.length - 1]!.id,
      state: "classified",
      last_action: "labeled",
      meta: {
        invoiceUpdateUnmet: true,
        missing: x.missing,
        note: "Invoice update requested but the new details aren't clear in the thread. State the change (e.g. new guest count) in the thread, then re-apply the label.",
      },
    })
    console.warn(`[invoice] update on ${id} unmet — missing: ${x.missing.join(", ")}`)
    return "unmet"
  }

  const booking = await getBookingByThread(id)
  // Rebuild every existing invoice kind from the latest numbers (deposit +
  // balance stay consistent). Keep the balance PDF for the draft if present.
  let attach: { invoiceNumber: string; pdf: Buffer; isBalance: boolean } | null = null
  for (const kind of kinds) {
    const built = await buildInvoiceFromExtraction(x, {
      bookingId: booking?.id ?? null,
      threadId: id,
      todayBrisbane: today,
      kind,
    })
    if (!attach || kind === "balance") {
      attach = { invoiceNumber: built.invoiceNumber, pdf: built.pdf, isBalance: kind === "balance" }
    }
  }
  if (!attach) return "empty"

  const playbook = await getPlaybook(category)
  const total = x.add_ons.reduce(
    (s, a) => s + a.unit_price * (a.per_person && x.guests ? x.guests : 1),
    (x.per_person_price ?? 0) * (x.guests ?? 0)
  )
  // A staffer may have already written or hand-edited the reply — the label
  // means "fix the invoice", not "rewrite my email". Keep their words and just
  // swap the attachment; only compose fresh text when no draft is pending.
  const existingBody = await getThreadDraftBody(id)
  let d: DraftResult
  if (existingBody) {
    d = { body: existingBody, confidence: 0.5, flags: ["needs_human"] }
  } else {
    d = await draft({
      category,
      playbook,
      threadHistory: thread.messages.map(toHistoryItem),
      customerName: x.customer_name ?? firstName(customerMsg.from),
      customExtras: [
        {
          role: "user",
          content:
            `The booking details have changed and we've UPDATED their invoice (${attach.invoiceNumber}) — it's ATTACHED as a PDF.\n` +
            `Current details: ${x.guests ?? "?"} guests${x.event_date ? `, ${x.event_date}` : ""}${
              x.time_label ? `, ${x.time_label}` : ""
            }; total $${total.toFixed(2)}.\n` +
            `Drafting rule: warm, short reply. Let them know we've updated their invoice to reflect the change and attached the new copy. Don't re-list every line. A couple of sentences.`,
        },
      ],
    })
  }
  if (!d.body) {
    await flagDraftFailure(thread, customerMsg, category)
    return "unmet"
  }
  if (!d.flags.includes("needs_human")) d.flags.push("needs_human")
  const safeName = (x.customer_name ?? "customer").replace(/[^A-Za-z0-9 ]/g, "").trim()
  await deliver(thread, customerMsg, d, category, playbook, {
    bcc: INVOICE_BCC, invoiceCreated: true,
    extraAttachments: [
      {
        filename: `${attach.invoiceNumber} - ${safeName}${attach.isBalance ? " (Balance)" : ""}.pdf`,
        contentType: "application/pdf",
        data: attach.pdf,
      },
    ],
  })
  console.log(`[invoice] rebuilt ${attach.invoiceNumber} for thread ${id} (${kinds.join("+")})`)
  return "rebuilt"
}

export async function runInvoiceUpdates(): Promise<{ processed: number }> {
  if (!invoiceConfigReady()) return { processed: 0 }
  // Make sure the label exists in Gmail so staff can find + apply it.
  await ensureLabel(UPDATE_INVOICE_LABEL).catch(() => {})
  const ids = await listThreadsByLabel(UPDATE_INVOICE_LABEL)
  let processed = 0
  for (const id of ids) {
    try {
      await processInvoiceRebuild(id)
      processed++
    } catch (e) {
      console.error(`[invoice] update-invoice ${id} failed:`, e instanceof Error ? e.message : e)
    } finally {
      await removeLabel(id, UPDATE_INVOICE_LABEL).catch(() => {})
    }
  }
  return { processed }
}

// --- function enquiry pipeline ---

async function handleFunctionEnquiry(
  thread: ParsedThread,
  latest: ParsedMessage,
  venue: Venue,
  category: Category
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  // Full, dequoted thread — booking extraction + invoice-stage detection both
  // read the ENTIRE conversation, not a truncated slice.
  const fullText = renderFullThread(thread.messages)

  // --- Finalised in-thread? Auto-build the deposit invoice from the FINAL
  // agreed details (date/time/numbers/package) and draft a reply with it
  // attached. Runs whether the booking was agreed via the agent or by staff
  // in plain email. One invoice per thread; always human-reviewed.
  try {
    if (await maybeAutoInvoice(thread, latest, venue, category, fullText)) {
      return true
    }
  } catch (e) {
    console.error(
      "[invoice] auto-build error:",
      e instanceof Error ? e.message : e
    )
  }

  const extracted = await extractBooking(fullText)
  const customerEmail = extractEmail(latest.from)
  const customerName =
    extracted.customer_name ?? firstName(latest.from) ?? null

  let booking = await getBookingByThread(thread.threadId)

  // --- Already locked in: customer replied AFTER a slot was selected /
  // invoiced / paid. Never re-propose slots or re-invoice — answer their
  // message as a normal follow-up and hand to a human (numbers changes,
  // dietaries, logistics all need a person on a committed booking).
  const COMMITTED_STATES = new Set([
    "slot_selected",
    "deposit_invoiced",
    "deposit_paid",
    "balance_invoiced",
    "paid",
  ])
  // Treat a thread we've already invoiced as committed too — never re-propose
  // slots to someone who's been booked and invoiced.
  const alreadyInvoiced = await threadHasInvoice(thread.threadId)
  if (alreadyInvoiced || (booking && COMMITTED_STATES.has(booking.state))) {
    const playbook = await getPlaybook(category)
    const allergenQ = await maybeAllergenBlock(
      latest.subject + "\n" + dequote(latest.bodyText)
    )
    const committedHistory = customerEmail
      ? renderCustomerHistory(await fetchCustomerHistory(customerEmail, thread.threadId))
      : ""
    const slotLabel = booking?.event_start
      ? new Date(booking.event_start).toLocaleString("en-AU", {
          timeZone: "Australia/Brisbane",
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "numeric",
          minute: "2-digit",
        })
      : null
    const d = await draft({
      category,
      playbook,
      threadHistory: thread.messages.map(toHistoryItem),
      customerName: customerName ?? undefined,
      customExtras: [
        ...(allergenQ ? [{ role: "user" as const, content: allergenQ }] : []),
        ...(committedHistory ? [{ role: "user" as const, content: committedHistory }] : []),
        {
          role: "user",
          content:
            `This customer already has a CONFIRMED function booking with us` +
            (slotLabel ? ` (${slotLabel}, ${booking?.pax ?? "?"} pax)` : "") +
            `. They are following up (a question, a change to numbers/dietaries, or logistics). ` +
            `Do NOT propose new dates or re-pitch packages. Answer their message warmly and briefly. ` +
            `If they want to change guest numbers, the date, or anything affecting the booking or invoice, acknowledge it and note a teammate will confirm — add "needs_human" to flags so a person actions it.`,
        },
      ],
    })
    if (!d.body) return await flagDraftFailure(thread, latest, category)
    if (!d.flags.includes("needs_human")) d.flags.push("needs_human")
    await deliver(thread, latest, d, category, playbook)
    return true
  }

  // --- Follow-up: customer replied to a slots-proposed booking ---
  // If we've already proposed slots, see whether their reply is a
  // confirmation. Runs for BOTH venues: the deposit invoice + calendar event
  // are created either way (the invoice is AUTHORISED in Xero with the PDF
  // attached to the email — void it in Xero if a booking falls through),
  // but for Tea Garden the locking-in REPLY carries needs_floor_layout_check
  // so it never auto-sends — a human confirms the layout, then hits send.
  // Only ever surface daytime, still-future slots — stale evening slots from
  // before the daytime rule must never be re-offered or confirmable.
  const liveSlots = booking ? liveDaytimeSlots(booking.proposed_slots) : []
  if (
    booking &&
    booking.state === "slots_proposed" &&
    liveSlots.length
  ) {
    const slotsHuman = liveSlots
      .map(
        (s, i) =>
          `${i + 1}. ${new Date(s.start).toLocaleString("en-AU", {
            timeZone: "Australia/Brisbane",
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "numeric",
            minute: "2-digit",
          })}`
      )
      .join("\n")
    const conf = await classifyConfirmation(slotsHuman, dequote(latest.bodyText))

    // Customer pulled out → close the booking gracefully, never re-pitch.
    if (conf.action === "declined" && conf.confidence >= 0.8) {
      await updateBooking(booking.id, { state: "cancelled" })
      const playbook = await getPlaybook(category)
      const d = await draft({
        category,
        playbook,
        threadHistory: thread.messages.map(toHistoryItem),
        customerName: customerName ?? undefined,
        customExtras: [
          {
            role: "user",
            content:
              "The customer has DECLINED / is no longer going ahead with the function. Write a short, gracious sign-off: thank them, no guilt-tripping, no re-pitching, warmly invite them back any time. 2-3 sentences.",
          },
        ],
      })
      if (!d.body) return await flagDraftFailure(thread, latest, category)
      await deliver(thread, latest, d, category, playbook)
      return true
    }

    // Customer asked a question about the proposal → answer it. Keep the
    // existing proposed slots (don't re-roll dates under them) and don't
    // re-run the full pitch.
    if (conf.action === "question") {
      const playbook = await getPlaybook(category)
      const allergenQ = await maybeAllergenBlock(
        latest.subject + "\n" + dequote(latest.bodyText)
      )
      const d = await draft({
        category,
        playbook,
        threadHistory: thread.messages.map(toHistoryItem),
        customerName: customerName ?? undefined,
        customExtras: [
          ...(allergenQ ? [{ role: "user" as const, content: allergenQ }] : []),
          {
            role: "user",
            content:
              `The customer is asking a QUESTION about a function we've already proposed times for — they haven't picked a slot yet.\n` +
              (conf.notes ? `Their question (summarised): ${conf.notes}\n` : "") +
              `Slots already proposed (still on offer — copy labels exactly if you restate them):\n${slotsHuman}\n` +
              `Drafting rule: answer their question directly from the playbook. Don't repeat the full pitch or re-list every package. End with a light nudge to lock in a time when they're ready.`,
          },
        ],
      })
      if (!d.body) return await flagDraftFailure(thread, latest, category)
      await deliver(thread, latest, d, category, playbook)
      return true
    }

    if (
      conf.action === "confirmed" &&
      conf.selected_slot_index !== null &&
      conf.selected_slot_index >= 0 &&
      conf.selected_slot_index < liveSlots.length
    ) {
      const chosen = liveSlots[conf.selected_slot_index]!
      await updateBooking(booking.id, {
        state: "slot_selected",
        event_start: new Date(chosen.start),
        event_end: new Date(chosen.end),
      })

      // Block the slot on the venue calendar so it can't be double-booked
      // (proposeSlots reads this calendar via isSlotFree). It's a TENTATIVE
      // ENQUIRY hold — NOT a confirmed booking — until the deposit is paid.
      try {
        if (!booking.calendar_event_id) {
          const calId = await createEvent(venue, {
            summary: `ENQUIRY (tentative hold) — ${customerName ?? "?"} (${booking.pax ?? "?"} pax)`,
            description: `Tentative hold from inbox booking ${booking.id}. NOT confirmed — awaiting customer go-ahead + deposit. Don't treat as locked.`,
            start: new Date(chosen.start),
            end: new Date(chosen.end),
            attendees: customerEmail ? [customerEmail] : undefined,
          })
          await updateBooking(booking.id, { calendar_event_id: calId })
        }
      } catch (e) {
        console.error("[booking] calendar hold failed:", e instanceof Error ? e.message : e)
      }

      // Generate OUR OWN deposit invoice PDF (no Xero — Chris 2026-06-13) when
      // the business + bank details are configured; attach it to the draft for
      // staff to check. If not configured, fall back to "invoice will follow".
      let invoicePdf: Attachment | undefined
      let invoiceNumber: string | undefined
      try {
        if (invoiceConfigReady()) {
          const gen = await generateDepositInvoice({
            bookingId: booking.id,
            threadId: thread.threadId,
            customerName: customerName ?? "",
            customerEmail: customerEmail ?? "",
            venueLabel: venue === "tea_garden" ? "Tea Garden" : "Beach House",
            eventDate: new Date(chosen.start),
            amount: FUNCTION_DEPOSIT_AUD,
            todayBrisbane: todayBrisbaneStr(),
          })
          invoiceNumber = gen.invoiceNumber
          invoicePdf = {
            filename: `${gen.invoiceNumber}.pdf`,
            contentType: "application/pdf",
            data: gen.pdf,
          }
        }
      } catch (e) {
        console.error("[booking] invoice generation failed:", e instanceof Error ? e.message : e)
      }
      // Draft a confirmation reply with the invoice attached
      const playbook = await getPlaybook(category)
      const history = customerEmail
        ? await fetchCustomerHistory(customerEmail, thread.threadId)
        : []
      const historyBlock = renderCustomerHistory(history)
      const slotLabel = new Date(chosen.start).toLocaleString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "numeric",
        minute: "2-digit",
      })
      const d = await draft({
        category,
        playbook,
        threadHistory: thread.messages.map(toHistoryItem),
        customerName: customerName ?? undefined,
        customExtras: [
          ...(historyBlock
            ? [{ role: "user" as const, content: historyBlock }]
            : []),
          {
            role: "user",
            content:
              `The customer has just CONFIRMED a function slot. Don't re-ask for confirmation — write a short locking-in reply.\n` +
              `Confirmed slot: ${slotLabel}\n` +
              `Pax: ${booking.pax ?? "unknown"}\n` +
              `Venue: ${venue === "tea_garden" ? "Tea Garden" : "Beach House"}\n` +
              `Deposit: $${FUNCTION_DEPOSIT_AUD} save-the-date deposit — it holds their date and comes off the final balance. (Once package and numbers are locked in, a 50% package deposit applies per our policy.)\n` +
              (invoicePdf
                ? `The deposit invoice (${invoiceNumber}) is ATTACHED to this email as a PDF with our bank details for payment. Mention the attached invoice and that paying it secures the date.\n`
                : `The deposit invoice is being prepared and will follow separately.\n`) +
              `\nDrafting rule: Thank them for confirming, restate the date/time briefly, ` +
              `mention the deposit invoice and link if provided, and say we look forward to having them. ` +
              `Keep it short.` +
              (venue === "tea_garden"
                ? ` This is a Tea Garden function: add "needs_floor_layout_check" to flags (a teammate confirms the floor layout before this reply goes out, so write it as locked in — no caveats to the customer).`
                : ""),
          },
        ],
      })
      if (!d.body) return await flagDraftFailure(thread, latest, category)
      // The attached invoice PDF is what staff/customers work from
      // (Chris 2026-06-12). If invoicing or the PDF export failed, hold
      // the reply as a draft for a human instead of auto-sending it
      // incomplete.
      if (!invoicePdf && !d.flags.includes("needs_human")) {
        d.flags.push("needs_human")
      }
      await deliver(thread, latest, d, category, playbook, {
        extraAttachments: invoicePdf ? [invoicePdf] : [],
      })
      return true
    }
    // Only "different_time" falls through — re-extract from their reply
    // and propose fresh slots for the new ask.
  }
  if (!booking) {
    const id = await insertBooking({
      thread_id: thread.threadId,
      venue,
      state: "enquiry_received",
      customer_email: customerEmail,
      customer_name: customerName,
      pax: extracted.pax,
      notes: extracted.notes,
    })
    booking = await getBookingByThread(thread.threadId)
    if (!booking) throw new Error(`booking ${id} vanished`)
  }

  const history = customerEmail
    ? await fetchCustomerHistory(customerEmail, thread.threadId)
    : []
  const historyBlock = renderCustomerHistory(history)

  // We do NOT auto-propose "available" time slots any more. The agent can't
  // see the full picture of what's booked (manual entries, Hideout / private
  // Tea Garden sections, functions not in NBI), so claiming a slot is free was
  // repeatedly wrong (Lisa, Kate, Kim — "already a function on 1-4pm"). A
  // human confirms the time against the real calendar. We work from the
  // customer's OWN requested date/time instead.
  const proposed: Array<{ start: string; end: string }> = []
  await updateBooking(booking.id, {
    state: "enquiry_received",
    notes: extracted.notes ?? booking.notes ?? undefined,
  })

  const playbook = await getPlaybook(category)
  const fnAllergenBlock = await maybeAllergenBlock(
    latest.subject + "\n" + dequote(latest.bodyText)
  )
  const reqTime = extracted.preferred_time
  const dateBlock = extracted.preferred_date
    ? `Customer's requested date: ${extracted.preferred_date}${reqTime ? ` at ${reqTime}` : " (no time given)"}`
    : extracted.date_range_start && extracted.date_range_end
      ? `Customer's date range: ${extracted.date_range_start} to ${extracted.date_range_end}${extracted.weekends_only ? " (weekends only)" : ""}${reqTime ? `, around ${reqTime}` : ""}`
      : "Date: not specified yet"
  // Check the team's real calendars (incl. all-day function entries) for the
  // customer's requested date so the agent answers accurately instead of
  // guessing. A human still confirms before sending.
  let calBlock = ""
  const checkDate = extracted.preferred_date ?? extracted.date_range_start
  if (checkDate) {
    try {
      const onDay = await eventsOnDate(checkDate)
      calBlock = onDay.length
        ? `\nWhat's ALREADY booked on ${checkDate} (from our team's calendar — internal, don't name other customers):\n` +
          onDay.map((e) => `  • ${e.timeLabel}: ${e.summary}`).join("\n") +
          `\nUse this: if their requested time clashes with one of these (or there's an all-day function on), gently tell them that time/day is already taken and ask for an alternative. If the day looks clear, you can say it looks available (a teammate will still confirm).\n`
        : `\nOur team's calendar shows NOTHING booked on ${checkDate} so far — the day looks open (a teammate will still confirm).\n`
    } catch {
      /* calendar unavailable — fall back to asking, never assert */
    }
  }
  const slotsBlock =
    "(Don't invent fixed time slots. Use the calendar info below + the customer's requested time.)" +
    calBlock
  const nbiContext = ""
  const teaGardenCaveat = ""
  const wideRangeNote = ""

  // Safety guards the drafter must respect.
  const guardNotes: string[] = []
  if (extracted.pax && extracted.pax > 30) {
    guardNotes.push(
      `Large group (${extracted.pax}). Don't make it sound hard — we CAN host big groups. Recommend Tea Garden whole-venue hire as the fit and refer them to the attached functions pack for packages/pricing. Do NOT list hire fees, package prices, bond or deposit figures in the email — keep it short. Add "needs_human".`
    )
  }
  if (!extracted.preferred_date && !extracted.date_range_start && /\b(\d{1,2})(st|nd|rd|th)?\b/.test(latest.subject + " " + latest.bodyText) && !/20\d\d/.test(latest.bodyText)) {
    guardNotes.push(
      `The customer gave a date with NO YEAR. Ask which year they mean before quoting availability — don't assume.`
    )
  }
  const soonCutoff = addDaysStr(todayBrisbaneStr(), 3)
  if (extracted.preferred_date && extracted.preferred_date <= soonCutoff) {
    guardNotes.push(
      `This is a SHORT-NOTICE request (within 3 days). Don't promise the date — say we'll check with the team today whether we can make it happen, and add "needs_human" to flags.`
    )
  }
  const holidaySlots = proposed.filter((s) =>
    QLD_PUBLIC_HOLIDAYS.has(s.start.slice(0, 10))
  )
  if (holidaySlots.length) {
    guardNotes.push(
      `One or more proposed dates fall on a QLD public holiday — mention that a public holiday surcharge applies (confirmed at booking).`
    )
  }

  // No-slots handling is venue-aware. Tea Garden is a shared cafe/garden that
  // seats many groups at once — we ACCOMMODATE group bookings, never decline
  // for "availability". Beach House (Hideout) is exclusive, so a clash there
  // does mean we ask for another date.
  const noSlotsRule =
    venue === "tea_garden"
      ? "DO NOT tell them we have no availability — we can host this group. Warmly confirm we'd love to have them on the date and time they asked for. If it's a group dining/table booking of 12 or more on any day EXCEPT Monday to Thursday (so Friday, Saturday or Sunday), a set menu is required: point them to our set menu packages (Set Brunch $45pp or Set Lunch $65pp, details in the attached functions pack), lay out the two options and ask which suits them best — and DON'T mention a deposit for a table booking. Ask for final numbers and any dietaries to lock it in. Write it as confirmed (a teammate does a final floor-layout check for the group size; no caveats to the customer)."
      : "We don't have the Hideout free on the date(s) they gave. Apologise briefly and ask for an alternative date window, don't make them spell out the same dates again."
  // Keep noSlotsRule referenced (Tea Garden accommodation phrasing) without
  // it claiming specific availability.
  void noSlotsRule

  const draftingRules =
    `Availability: use the "What's already booked" calendar info above (our team's real calendar). Respond ACCURATELY:\n` +
    `- If their requested date/time clashes with an existing booking (or an all-day function), DON'T offer that time — gently say it's already taken and ask for an alternative.\n` +
    `- If the day looks clear, you can warmly confirm it looks available for their requested time (a teammate still does a final confirm).\n` +
    `- Don't invent a list of fixed time slots. Work from the customer's requested time; if they gave none, ask what time they're thinking. If they gave no date, ask for one.\n` +
    `- For a Tea Garden GROUP DINING (table) booking, say we'd love to have them and we're flexible on timing within opening hours.\n` +
    `- Ask for final numbers and any dietaries.\n` +
    `- ALWAYS add "needs_human" to flags so a teammate confirms availability before this sends.` +
    (guardNotes.length ? "\nGuards:\n- " + guardNotes.join("\n- ") : "")

  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: customerName ?? undefined,
    customExtras: [
      ...(historyBlock
        ? [{ role: "user" as const, content: historyBlock }]
        : []),
      ...(fnAllergenBlock
        ? [{ role: "user" as const, content: fnAllergenBlock }]
        : []),
      {
        role: "user",
        content:
          `Booking flow info (use this when drafting):\n` +
          `Venue: ${venue === "tea_garden" ? "Tea Garden" : "Beach House"}\n` +
          `Pax: ${extracted.pax ?? "unknown"}\n` +
          `${dateBlock}\n` +
          `Slots:\n${slotsBlock}\n` +
          nbiContext +
          `Deposit rule: a $${FUNCTION_DEPOSIT_AUD} deposit applies ONLY to EXCLUSIVE PRIVATE HIRE (whole-venue hire, or a private styled function like a baby shower / hens in the Hideout). A group that just wants a TABLE for breakfast / brunch / lunch (even 15+ people) is a normal dining booking — NO deposit, do not mention one; just confirm the table, the set menu for tables of 12 or more (Set Brunch $45pp or Set Lunch $65pp; required Friday to Sunday, not needed Monday to Thursday), and take their final numbers and dietaries. Judge which this is from what the customer actually asked for; when unsure, treat it as a table booking and don't raise a deposit.\n` +
          `\nDrafting rule: ${draftingRules}\n`,
      },
    ],
  })
  if (!d.body) return await flagDraftFailure(thread, latest, category)
  // Tables of 12+ get their own folder (so staff can eyeball every large group
  // at a glance) and the functions pack in hand (it holds the set-menu options).
  // bookings_dine_in has no default attachment, so attach it here on our first
  // reply when the group is large enough to need a set menu.
  const large = (extracted.pax ?? 0) >= 12
  if (large) await applyLabel(thread.threadId, LARGE_BOOKING_LABEL).catch(() => {})
  const setMenuAttachments =
    large && isOurFirstReply(thread, config().HELLO_MAILBOX)
      ? await loadAttachments(["functions-events-packages.pdf"])
      : []
  await deliver(thread, latest, d, category, playbook, { extraAttachments: setMenuAttachments })
  return true
}

/** Walk through a date range (inclusive) and return up to MAX_SLOTS_PROPOSED
 *  free time-slots. Optionally restricts to weekends. Stops early once it
 *  has found enough. */
/** Weekday of a calendar date string, independent of server timezone. */
function dateStrDow(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun, 6=Sat
}

function addDaysStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

async function proposeSlotsInRange(
  venue: Venue,
  startStr: string,
  endStr: string,
  weekendsOnly: boolean,
  timeStr: string | null,
  durationHours: number
): Promise<Array<{ start: string; end: string }>> {
  // Walk calendar-date STRINGS, never Date objects: the container runs in
  // UTC, so Date#getDay()/#getDate() on a +10:00 instant land a day early —
  // that's how "Saturday 2 August" went to a customer when Aug 2 is a Sunday.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr))
    return []
  const out: Array<{ start: string; end: string }> = []
  const MAX_DAYS = 120
  let cursor = startStr
  let days = 0
  while (cursor <= endStr && days < MAX_DAYS) {
    if (out.length >= MAX_SLOTS_PROPOSED) break
    const dow = dateStrDow(cursor)
    if (!weekendsOnly || dow === 0 || dow === 6) {
      // One slot per candidate day to keep prompt size sane.
      const slots = await proposeSlots(venue, cursor, timeStr, durationHours)
      if (slots.length) out.push(slots[0]!)
    }
    cursor = addDaysStr(cursor, 1)
    days++
  }
  return out
}

// Daytime venue: nothing starts after mid-afternoon (Chris 2026-06-12: "we do
// not offer nights yet"). Earliest 07:00 covers the Tea Garden's 7:30am
// weekend opening for group breakfasts. Evening requests are ignored here;
// the drafter explains daytime-only.
const EARLIEST_START_HOUR = 7
const LATEST_START_HOUR = 14

function todayBrisbaneStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
  }).format(new Date())
}

/**
 * Drops any stored slot that isn't a daytime start or has already passed.
 * Guards against stale proposed_slots from before the daytime rule existed
 * (and from any future bug) ever being re-offered to a customer.
 */
function liveDaytimeSlots(
  slots: Array<{ start: string; end: string }>
): Array<{ start: string; end: string }> {
  const now = Date.now()
  return slots.filter((s) => {
    // Past check on the absolute instant — NOT a UTC date-string slice, which
    // is off by a day for morning Brisbane slots (their UTC date is the day
    // before, so a still-future 9:30am slot was wrongly dropped).
    if (new Date(s.start).getTime() <= now) return false
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Australia/Brisbane",
        hour: "2-digit",
        hour12: false,
      }).format(new Date(s.start))
    )
    return hour >= EARLIEST_START_HOUR && hour <= LATEST_START_HOUR
  })
}

// QLD public holidays (statewide). Update yearly; Gold Coast Show Day
// (late Aug, region-gazetted) is deliberately omitted — confirm before adding.
const QLD_PUBLIC_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-26", "2026-04-03", "2026-04-04", "2026-04-05",
  "2026-04-06", "2026-04-25", "2026-05-04", "2026-10-05", "2026-12-25",
  "2026-12-26", "2026-12-28",
  "2027-01-01", "2027-01-26", "2027-03-26", "2027-03-27", "2027-03-28",
  "2027-03-29", "2027-04-25", "2027-05-03", "2027-10-04", "2027-12-25",
  "2027-12-27", "2027-12-28",
])

async function proposeSlots(
  venue: Venue,
  dateStr: string,
  timeStr: string | null,
  durationHours: number
): Promise<Array<{ start: string; end: string }>> {
  // Never propose today or the past — same-day functions need a human, and
  // a past date means the extraction misread (or the enquiry is stale).
  if (dateStr <= todayBrisbaneStr()) return []
  // Candidate slots: the customer's preferred time (if within daytime
  // hours) + lunch (12:00) + morning (9:30).
  const candidates: Array<{ hour: number; minute: number }> = []
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number) as [number, number]
    if (!Number.isNaN(h) && h >= EARLIEST_START_HOUR && h <= LATEST_START_HOUR) {
      candidates.push({ hour: h, minute: m ?? 0 })
    }
  }
  for (const c of [
    { hour: 12, minute: 0 },
    { hour: 9, minute: 30 },
  ]) {
    if (!candidates.some((x) => x.hour === c.hour && x.minute === c.minute)) {
      candidates.push(c)
    }
  }
  const out: Array<{ start: string; end: string }> = []
  for (const c of candidates) {
    if (out.length >= MAX_SLOTS_PROPOSED) break
    const start = new Date(`${dateStr}T${pad(c.hour)}:${pad(c.minute)}:00+10:00`)
    const end = new Date(start.getTime() + durationHours * 3600_000)
    if (!(await isSlotFree(venue, { start, end }))) continue
    // The Google calendar only holds functions we created — Now Book It
    // bookings live in inbox_nbi_bookings. For Tea Garden, a slot with 3+
    // overlapping high teas isn't really available (shared space). Beach
    // House functions are in the Hideout (private space upstairs), so
    // restaurant bookings downstairs don't block them.
    if (venue === "tea_garden") {
      const highTeas = await nbiOverlapCount("%high tea%", { start, end }, 90)
      if (highTeas >= 3) continue
    }
    out.push({ start: start.toISOString(), end: end.toISOString() })
  }
  return out
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

// --- called when customer confirms a slot (manual progression for now) ---
export async function progressBookingToInvoice(bookingId: number): Promise<void> {
  const { rows } = await (await import("./db/pool.js")).db().query(
    `SELECT * FROM inbox_bookings WHERE id = $1`,
    [bookingId]
  )
  const b = rows[0]
  if (!b) throw new Error(`booking ${bookingId} not found`)
  if (!b.customer_email || !b.customer_name) {
    throw new Error("booking missing customer email/name")
  }
  if (!b.event_start || !b.event_end) {
    throw new Error("booking has no confirmed slot — set event_start/end first")
  }
  const contactId = await findOrCreateContact(
    b.customer_email,
    b.customer_name
  )
  const ref = `Function ${b.venue} ${new Date(b.event_start).toISOString().slice(0, 10)}`
  const depositId = await createAuthorisedInvoice({
    contactId,
    reference: `${ref} — save-the-date deposit`,
    lines: [
      {
        // Matches the published policy: $500 save-the-date holds the date;
        // the 50% package deposit follows once package + numbers are locked.
        description: `Save-the-date deposit to hold ${b.venue.replace("_", " ")} function on ${new Date(b.event_start).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane" })} (applied toward your final balance)`,
        quantity: 1,
        unitAmount: FUNCTION_DEPOSIT_AUD,
      },
    ],
  })
  const calendarEventId = await createEvent(b.venue, {
    summary: `DEPOSIT INVOICED — ${b.customer_name} (${b.pax ?? "?"} pax)`,
    description: `From inbox booking ${b.id}. Deposit invoice ${depositId} raised — confirmed once deposit is paid.`,
    start: new Date(b.event_start),
    end: new Date(b.event_end),
    attendees: [b.customer_email],
  })
  await updateBooking(b.id, {
    state: "deposit_invoiced",
    xero_contact_id: contactId,
    xero_deposit_invoice_id: depositId,
    calendar_event_id: calendarEventId,
  })
  const url = await getInvoiceOnlineUrl(depositId)
  console.log(`[booking ${b.id}] deposit invoice ${depositId} ready: ${url ?? "(no online url)"}`)
}

// --- edit capture ---

async function captureEdit(
  thread: ParsedThread,
  meta: Record<string, unknown>
): Promise<void> {
  const draftedAtStr = meta["draftedAt"] as string | undefined
  const draftBody = meta["draftBody"] as string | undefined
  const category = meta["category"] as string | undefined
  if (!draftedAtStr || !draftBody) return
  const draftedAt = new Date(draftedAtStr)
  const sent = await findOurSentReply(
    thread,
    config().HELLO_MAILBOX,
    draftedAt
  )
  if (!sent) return
  // Compare like with like: the sent message's bodyText includes the QUOTED
  // THREAD below the reply (and often a signature), which the draft never
  // had — raw comparison made every verbatim send look like a ~1,000-char
  // rewrite and kept the auto-send trust data permanently at 0% verbatim.
  const sentBody = dequote(sent.bodyText).trim()
  const a = normalizeForDiff(draftBody)
  const b = normalizeForDiff(sentBody)
  // Record verbatim sends too (edit_distance 0) — they're the trust signal
  // for promoting a category to auto-send, and silently dropping them left
  // us blind to how good the drafts actually were.
  await recordLearning({
    thread_id: thread.threadId,
    category: category ?? null,
    our_draft: draftBody,
    sent_reply: sentBody,
    edit_distance: a === b ? 0 : levenshtein(a, b),
  })
}

/** Whitespace/quote-mark noise must not count as an "edit". */
export function normalizeForDiff(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j]!, dp[j - 1]!)
      prev = tmp
    }
  }
  return dp[b.length]!
}
