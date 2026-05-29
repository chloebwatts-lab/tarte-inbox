// Per-thread orchestration. Called by the scheduler for each unread inbox thread.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  getThread,
  listInboxThreads,
  applyLabel,
  createInThreadDraft,
  sendInThreadReply,
  findOurSentReply,
  createForwardDraft,
  sendForward,
  mimeTypeFor,
  type Attachment,
  type ParsedThread,
  type ParsedMessage,
} from "./google/gmail.js"
import { isSlotFree, createEvent, type Venue } from "./google/calendar.js"
import {
  fetchCustomerHistory,
  renderCustomerHistory,
} from "./google/customer-history.js"
import {
  findOrCreateContact,
  createDraftInvoice,
  getInvoiceOnlineUrl,
  getInvoicePdf,
} from "./xero/client.js"
import {
  classify,
  CATEGORY_LABELS,
  type Category,
} from "./llm/classifier.js"
import { draft, type DraftResult } from "./llm/drafter.js"
import { extractBooking } from "./llm/booking.js"
import { classifyConfirmation } from "./llm/confirmation.js"
import { dequote } from "./lib/dequote.js"
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
const BALANCE_DAYS_BEFORE_EVENT = 14

// --- entry ---

export async function runTick(): Promise<{ seen: number; acted: number }> {
  const runId = await startRun()
  let seen = 0
  let acted = 0
  try {
    const ids = await listInboxThreads()
    seen = ids.length
    for (const id of ids) {
      try {
        const acted_ = await processThread(id)
        if (acted_) acted++
      } catch (e) {
        console.error(`[pipeline] thread ${id} failed:`, e)
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
  /@nowbookit\.com/i, // booking confirmations, automated only
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

function isAutomatedReceipt(from: string, subject: string): boolean {
  const lowerFrom = from.toLowerCase()
  if (NOREPLY_SENDER_PATTERNS.some((p) => p.test(lowerFrom))) return true
  // Receipt subject + a transactional sender prefix (orders@, billing@, etc.)
  const transactionalSender = /(?:^|<)(orders?|billing|accounts?|invoices?|sales|info|admin|support|service)@/i
  if (
    transactionalSender.test(lowerFrom) &&
    RECEIPT_SUBJECT_PATTERNS.some((p) => p.test(subject))
  ) {
    return true
  }
  return false
}

export async function processThread(threadId: string): Promise<boolean> {
  const thread = await getThread(threadId)
  if (!thread.messages.length) return false
  const latest = thread.messages[thread.messages.length - 1]!
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const fromUs = latest.from.toLowerCase().includes(helloMail)

  const existing = await getThreadRow(threadId)

  // Edit-capture: if the latest message is ours, and we previously drafted, log diff.
  if (fromUs && existing?.last_action === "drafted") {
    await captureEdit(thread, existing.meta)
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "sent_by_human",
      last_action: "captured_edit",
    })
    return true
  }

  // Skip if nothing new since last time
  if (existing?.last_message_id === latest.id) return false

  // Skip if no human-facing message (e.g. fully internal/automated)
  if (fromUs) {
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      last_action: "skipped_outbound",
    })
    return false
  }

  // Strip quoted blocks + auto-mailer boilerplate from the latest body
  // before classifying — keeps signal clean when the customer replied into
  // a NBI confirmation or Outlook-quoted chain.
  const cleanLatestBody = dequote(latest.bodyText)

  // --- classify ---
  const result = await classify(latest.subject, latest.from, cleanLatestBody)
  const label = CATEGORY_LABELS[result.category]
  await applyLabel(threadId, label)

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

  // Handed off to a human via forward (e.g. shawna@tarte.com.au)?
  // Label only, don't draft. Shawna will reply directly.
  if (threadHandedOff(thread)) {
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "handed_off",
      last_action: "skipped_handoff",
    })
    return true
  }

  // Automated notification (noreply, order confirmation, statement, etc).
  // No human at the other end, label only.
  if (isAutomatedReceipt(latest.from, latest.subject)) {
    await upsertThread({
      thread_id: threadId,
      last_message_id: latest.id,
      state: "noreply_skipped",
      last_action: "skipped_noreply",
    })
    return true
  }

  // --- forward-only categories (e.g. job_applications → work@) ---
  // If the playbook has a forward_to address, we forward the original
  // email to that team instead of drafting a reply to the sender.
  const earlyPlaybook = await getPlaybook(result.category)
  if (earlyPlaybook?.forward_to) {
    return await forwardThread(thread, latest, result.category, earlyPlaybook.forward_to)
  }

  // --- function-flow shortcut for events ---
  const venue = VENUE_BY_CATEGORY[result.category]
  if (venue && result.category !== "events_tea_garden_high_tea") {
    return await handleFunctionEnquiry(thread, latest, venue, result.category)
  }

  // --- generic drafter for other categories ---
  if (result.category === "marketing_cold_outreach" || result.category === "needs_human" || result.category === "accounts_invoices") {
    // Label only, no draft.
    return true
  }

  const playbook = earlyPlaybook
  const customerEmailAddr = extractEmail(latest.from)
  const history = customerEmailAddr
    ? await fetchCustomerHistory(customerEmailAddr, thread.threadId)
    : []
  const historyBlock = renderCustomerHistory(history)
  const d = await draft({
    category: result.category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: firstName(latest.from),
    customExtras: historyBlock
      ? [{ role: "user", content: historyBlock }]
      : undefined,
  })
  if (!d.body) return true

  return await deliver(thread, latest, d, result.category, playbook)
}

// --- helpers ---

function toHistoryItem(m: ParsedMessage): { from: string; date: Date; text: string } {
  // Dequote so the drafter doesn't see NBI confirmation boilerplate or
  // Outlook-quoted chain noise. Keeps the prompt focused on real content.
  return { from: m.from, date: m.date, text: dequote(m.bodyText).slice(0, 4000) }
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
async function forwardThread(
  thread: ParsedThread,
  latest: ParsedMessage,
  category: Category,
  forwardTo: string
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  const pb = await getPlaybook(category)
  const shouldAutoSend =
    config().ENABLE_AUTO_SEND && pb?.auto_send === true
  if (shouldAutoSend) {
    const sentId = await sendForward(
      latest,
      forwardTo,
      helloMail,
      "Tarte Inbox"
    )
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      state: "forwarded",
      last_action: "sent_forward",
      meta: { forwardTo, sentMessageId: sentId, category },
    })
    return true
  }
  const draftId = await createForwardDraft(
    latest,
    forwardTo,
    helloMail,
    "Tarte Inbox"
  )
  await upsertThread({
    thread_id: thread.threadId,
    last_message_id: latest.id,
    state: "forward_drafted",
    last_action: "drafted_forward",
    meta: {
      forwardTo,
      forwardDraftId: draftId,
      category,
    },
  })
  return true
}

async function deliver(
  thread: ParsedThread,
  latest: ParsedMessage,
  d: DraftResult,
  category: Category,
  playbook: Awaited<ReturnType<typeof getPlaybook>>,
  opts: { extraAttachments?: Attachment[] } = {}
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  const ctx = {
    threadId: thread.threadId,
    to: latest.from,
    subject: latest.subject,
    inReplyTo: latest.messageIdHeader ?? "",
    references: latest.references ?? latest.messageIdHeader ?? "",
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
    !d.flags.includes("needs_floor_layout_check")

  if (shouldAutoSend) {
    const sentId = await sendInThreadReply(
      ctx,
      d.body,
      helloMail,
      "Tarte Team",
      attachments
    )
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "auto_sent",
      last_action: "sent",
      meta: {
        sentMessageId: sentId,
        draftConfidence: d.confidence,
        flags: d.flags,
        attachmentCount: attachments.length,
      },
    })
    return true
  }
  const draftId = await createInThreadDraft(
    ctx,
    d.body,
    helloMail,
    "Tarte Team",
    attachments
  )
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

// --- function enquiry pipeline ---

async function handleFunctionEnquiry(
  thread: ParsedThread,
  latest: ParsedMessage,
  venue: Venue,
  category: Category
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  const fullText = thread.messages.map((m) => m.bodyText).join("\n\n---\n\n")
  const extracted = await extractBooking(fullText)
  const customerEmail = extractEmail(latest.from)
  const customerName =
    extracted.customer_name ?? firstName(latest.from) ?? null

  let booking = await getBookingByThread(thread.threadId)

  // --- Follow-up: customer replied to a slots-proposed booking ---
  // If we've already proposed slots, see whether their reply is a
  // confirmation. Only run for Beach House (Tea Garden still gates on
  // floor-layout check, which is a human).
  if (
    booking &&
    booking.state === "slots_proposed" &&
    booking.proposed_slots.length &&
    venue === "beach_house"
  ) {
    const slotsHuman = booking.proposed_slots
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
    const conf = await classifyConfirmation(slotsHuman, latest.bodyText)
    if (
      conf.action === "confirmed" &&
      conf.selected_slot_index !== null &&
      conf.selected_slot_index >= 0 &&
      conf.selected_slot_index < booking.proposed_slots.length
    ) {
      const chosen = booking.proposed_slots[conf.selected_slot_index]!
      await updateBooking(booking.id, {
        state: "slot_selected",
        event_start: new Date(chosen.start),
        event_end: new Date(chosen.end),
      })
      // Auto-progress: create Xero deposit invoice + calendar event
      let invoiceUrl: string | undefined
      let invoicePdf: Attachment | undefined
      try {
        const updated = await getBookingByThread(thread.threadId)
        if (updated) {
          await progressBookingToInvoice(updated.id)
          const after = await getBookingByThread(thread.threadId)
          if (after?.xero_deposit_invoice_id) {
            const invoiceId = after.xero_deposit_invoice_id
            invoiceUrl = await getInvoiceOnlineUrl(invoiceId)
            // Attach current PDF snapshot. If the team edits the invoice
            // in Xero after this email is generated, they can re-fetch by
            // having the agent re-tick (or just refer to the Xero URL).
            try {
              const pdfBytes = await getInvoicePdf(invoiceId)
              invoicePdf = {
                filename: `deposit-invoice-${invoiceId.slice(0, 8)}.pdf`,
                contentType: "application/pdf",
                data: pdfBytes,
              }
            } catch (e) {
              console.warn(
                "[booking] PDF fetch failed, continuing without:",
                e instanceof Error ? e.message : e
              )
            }
          }
        }
      } catch (e) {
        console.error(
          "[booking] auto-invoice failed:",
          e instanceof Error ? e.message : e
        )
      }
      // Draft a confirmation reply with the invoice link
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
              `Venue: Beach House\n` +
              `Deposit amount: $${FUNCTION_DEPOSIT_AUD}\n` +
              (invoiceUrl
                ? `Deposit invoice payment link: ${invoiceUrl}\n`
                : `The deposit invoice is being prepared and will follow separately.\n`) +
              `\nDrafting rule: Thank them for confirming, restate the date/time briefly, ` +
              `mention the deposit invoice and link if provided, and say we look forward to having them. ` +
              `Keep it short.`,
          },
        ],
      })
      if (d.body) {
        await deliver(thread, latest, d, category, playbook, {
          extraAttachments: invoicePdf ? [invoicePdf] : [],
        })
      }
      return true
    }
    // If not a confirmation (different_time / question / declined),
    // fall through to the normal drafting flow below.
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

  // For Tea Garden functions we don't propose slots — defer to human (no NBI feed).
  if (venue === "tea_garden") {
    const playbook = await getPlaybook(category)
    const d = await draft({
      category,
      playbook,
      threadHistory: thread.messages.map(toHistoryItem),
      customerName: customerName ?? undefined,
      customExtras: historyBlock
        ? [{ role: "user", content: historyBlock }]
        : undefined,
    })
    if (d.body) {
      await deliver(thread, latest, d, category, playbook)
    }
    return true
  }

  // Beach House: propose slots from the calendar.
  // Three cases:
  //   1. Customer named a specific day → propose times on that day.
  //   2. Customer gave a date range (e.g. "last weekend in July") → enumerate
  //      candidate days within the range and propose free ones.
  //   3. No date info at all → no slots, drafter writes a holding reply.
  let proposed: Array<{ start: string; end: string }> = []
  const duration = extracted.duration_hours ?? SLOT_DURATION_DEFAULT_HOURS
  if (extracted.preferred_date) {
    proposed = await proposeSlots(
      venue,
      extracted.preferred_date,
      extracted.preferred_time,
      duration
    )
  } else if (extracted.date_range_start && extracted.date_range_end) {
    proposed = await proposeSlotsInRange(
      venue,
      extracted.date_range_start,
      extracted.date_range_end,
      extracted.weekends_only,
      extracted.preferred_time,
      duration
    )
  }
  await updateBooking(booking.id, {
    state: proposed.length ? "slots_proposed" : "enquiry_received",
    proposed_slots: proposed,
    notes: extracted.notes ?? booking.notes ?? undefined,
  })

  const playbook = await getPlaybook(category)
  const slotsBlock = proposed.length
    ? "Available windows that look open:\n" +
      proposed
        .map(
          (s) =>
            `  • ${new Date(s.start).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}`
        )
        .join("\n")
    : "We'll come back to you with available windows shortly."

  const dateBlock = extracted.preferred_date
    ? `Preferred date: ${extracted.preferred_date}`
    : extracted.date_range_start && extracted.date_range_end
      ? `Customer's date range: ${extracted.date_range_start} to ${extracted.date_range_end}${extracted.weekends_only ? " (weekends only)" : ""}`
      : "Date: unspecified"

  const draftingRules = proposed.length
    ? "We've already checked the calendar — propose the slots above to the customer; DON'T ask them to re-confirm dates they've already given."
    : "No slots are available in the date(s) they gave. Apologise briefly and ask them for an alternative date window — don't make them spell out the same dates again."

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
          `Booking flow info (use this when drafting):\n` +
          `Venue: Beach House\n` +
          `Pax: ${extracted.pax ?? "unknown"}\n` +
          `${dateBlock}\n` +
          `Slots:\n${slotsBlock}\n` +
          `Deposit to hold the date: $${FUNCTION_DEPOSIT_AUD}\n` +
          `\nDrafting rule: ${draftingRules}\n`,
      },
    ],
  })
  if (d.body) {
    await deliver(thread, latest, d, category, playbook)
  }
  return true
}

/** Walk through a date range (inclusive) and return up to MAX_SLOTS_PROPOSED
 *  free time-slots. Optionally restricts to weekends. Stops early once it
 *  has found enough. */
async function proposeSlotsInRange(
  venue: Venue,
  startStr: string,
  endStr: string,
  weekendsOnly: boolean,
  timeStr: string | null,
  durationHours: number
): Promise<Array<{ start: string; end: string }>> {
  const start = new Date(`${startStr}T00:00:00+10:00`)
  const end = new Date(`${endStr}T23:59:59+10:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []
  const out: Array<{ start: string; end: string }> = []
  // Walk day-by-day. Bail at 90 days to prevent runaway loops.
  const MAX_DAYS = 90
  let days = 0
  const cursor = new Date(start)
  while (cursor <= end && days < MAX_DAYS) {
    if (out.length >= MAX_SLOTS_PROPOSED) break
    const dow = cursor.getDay() // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6
    if (!weekendsOnly || isWeekend) {
      const yyyymmdd =
        cursor.getFullYear() +
        "-" +
        pad(cursor.getMonth() + 1) +
        "-" +
        pad(cursor.getDate())
      // For each candidate day, try just one time slot to keep prompt size sane.
      // Default to the customer's preferred time, else 12:00 (lunch).
      const slots = await proposeSlots(venue, yyyymmdd, timeStr, durationHours)
      if (slots.length) out.push(slots[0]!)
    }
    cursor.setDate(cursor.getDate() + 1)
    days++
  }
  return out
}

async function proposeSlots(
  venue: Venue,
  dateStr: string,
  timeStr: string | null,
  durationHours: number
): Promise<Array<{ start: string; end: string }>> {
  // Generate candidate slots: preferred time + lunch (12:00) + evening (18:00).
  const candidates: Array<{ hour: number; minute: number }> = []
  if (timeStr) {
    const [h, m] = timeStr.split(":").map(Number) as [number, number]
    if (!Number.isNaN(h)) candidates.push({ hour: h, minute: m ?? 0 })
  }
  for (const c of [
    { hour: 12, minute: 0 },
    { hour: 18, minute: 0 },
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
    if (await isSlotFree(venue, { start, end })) {
      out.push({ start: start.toISOString(), end: end.toISOString() })
    }
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
  const depositId = await createDraftInvoice({
    contactId,
    reference: `${ref} — deposit`,
    lines: [
      {
        description: `Deposit to hold ${b.venue.replace("_", " ")} function on ${new Date(b.event_start).toLocaleDateString("en-AU")}`,
        quantity: 1,
        unitAmount: FUNCTION_DEPOSIT_AUD,
      },
    ],
  })
  const calendarEventId = await createEvent(b.venue, {
    summary: `Function — ${b.customer_name} (${b.pax ?? "?"} pax) — DEPOSIT PENDING`,
    description: `Auto-created from inbox booking ${b.id}. Xero deposit invoice ${depositId}.`,
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
  const sentBody = sent.bodyText.trim()
  if (sentBody === draftBody.trim()) return
  await recordLearning({
    thread_id: thread.threadId,
    category: category ?? null,
    our_draft: draftBody,
    sent_reply: sentBody,
    edit_distance: levenshtein(draftBody.trim(), sentBody),
  })
}

function levenshtein(a: string, b: string): number {
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
