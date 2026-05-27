// Per-thread orchestration. Called by the scheduler for each unread inbox thread.

import {
  getThread,
  listInboxThreads,
  applyLabel,
  createInThreadDraft,
  sendInThreadReply,
  findOurSentReply,
  type ParsedThread,
  type ParsedMessage,
} from "./google/gmail.js"
import { isSlotFree, createEvent, type Venue } from "./google/calendar.js"
import {
  findOrCreateContact,
  createDraftInvoice,
  getInvoiceOnlineUrl,
} from "./xero/client.js"
import {
  classify,
  CATEGORY_LABELS,
  type Category,
} from "./llm/classifier.js"
import { draft, type DraftResult } from "./llm/drafter.js"
import { extractBooking } from "./llm/booking.js"
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

async function processThread(threadId: string): Promise<boolean> {
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

  // --- classify ---
  const result = await classify(latest.subject, latest.from, latest.bodyText)
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

  const playbook = await getPlaybook(result.category)
  const d = await draft({
    category: result.category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: firstName(latest.from),
  })
  if (!d.body) return true

  return await deliver(thread, latest, d, result.category, playbook)
}

// --- helpers ---

function toHistoryItem(m: ParsedMessage): { from: string; date: Date; text: string } {
  return { from: m.from, date: m.date, text: m.bodyText.slice(0, 4000) }
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

async function deliver(
  thread: ParsedThread,
  latest: ParsedMessage,
  d: DraftResult,
  category: Category,
  playbook: Awaited<ReturnType<typeof getPlaybook>>
): Promise<boolean> {
  const helloMail = config().HELLO_MAILBOX
  const ctx = {
    threadId: thread.threadId,
    to: latest.from,
    subject: latest.subject,
    inReplyTo: latest.messageIdHeader ?? "",
    references: latest.references ?? latest.messageIdHeader ?? "",
  }
  const shouldAutoSend =
    config().ENABLE_AUTO_SEND &&
    playbook?.auto_send === true &&
    d.confidence >= (playbook?.min_confidence ?? 0.95) &&
    !d.flags.includes("needs_human") &&
    !d.flags.includes("needs_floor_layout_check")

  if (shouldAutoSend) {
    const sentId = await sendInThreadReply(ctx, d.body, helloMail, "Tarte Team")
    await upsertThread({
      thread_id: thread.threadId,
      last_message_id: latest.id,
      last_history_id: thread.historyId ?? null,
      state: "auto_sent",
      last_action: "sent",
      meta: { sentMessageId: sentId, draftConfidence: d.confidence, flags: d.flags },
    })
    return true
  }
  const draftId = await createInThreadDraft(
    ctx,
    d.body,
    helloMail,
    "Tarte Team"
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

  // For Tea Garden functions we don't propose slots — defer to human (no NBI feed).
  if (venue === "tea_garden") {
    const playbook = await getPlaybook(category)
    const d = await draft({
      category,
      playbook,
      threadHistory: thread.messages.map(toHistoryItem),
      customerName: customerName ?? undefined,
    })
    if (d.body) {
      await deliver(thread, latest, d, category, playbook)
    }
    return true
  }

  // Beach House: propose slots from the calendar if we have date/time info.
  let proposed: Array<{ start: string; end: string }> = []
  if (extracted.preferred_date) {
    proposed = await proposeSlots(
      venue,
      extracted.preferred_date,
      extracted.preferred_time,
      extracted.duration_hours ?? SLOT_DURATION_DEFAULT_HOURS
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

  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map(toHistoryItem),
    customerName: customerName ?? undefined,
    customExtras: [
      {
        role: "user",
        content:
          `Booking flow info (use this when drafting):\n` +
          `Venue: Beach House\n` +
          `Pax: ${extracted.pax ?? "unknown"}\n` +
          `Preferred date: ${extracted.preferred_date ?? "unspecified"}\n` +
          `Slots:\n${slotsBlock}\n` +
          `Deposit to hold the date: $${FUNCTION_DEPOSIT_AUD}\n`,
      },
    ],
  })
  if (d.body) {
    await deliver(thread, latest, d, category, playbook)
  }
  return true
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
