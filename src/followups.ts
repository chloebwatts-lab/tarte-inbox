// Booking follow-ups: customers who were proposed function slots and went
// quiet get ONE friendly nudge draft after NUDGE_AFTER_DAYS. Drafts only —
// never auto-sent — so a human always eyeballs the nudge before it goes.

import { getThread, type ParsedMessage } from "./google/gmail.js"
import { draft } from "./llm/drafter.js"
import { getPlaybook } from "./db/queries.js"
import { db } from "./db/pool.js"
import { config } from "./config.js"
import { deliverNudgeDraft, dismissTrashedThread } from "./pipeline.js"

/** Staff deleted the thread → never nudge it. */
function isTrashed(thread: { messages: Array<{ labelIds: string[] }> }): boolean {
  const latest = thread.messages[thread.messages.length - 1]
  return Boolean(latest?.labelIds.includes("TRASH"))
}
import type { Category } from "./llm/classifier.js"

const NUDGE_AFTER_DAYS = 3

const CATEGORY_BY_VENUE: Record<string, Category> = {
  tea_garden: "events_tea_garden_functions",
  beach_house: "events_beach_house_functions",
}

interface StaleBooking {
  id: number
  thread_id: string
  venue: string
  customer_name: string | null
  pax: number | null
  proposed_slots: Array<{ start: string; end: string }>
  updated_at: Date
}

export async function nudgeStaleBookings(): Promise<{ nudged: number }> {
  const { rows } = await db().query<StaleBooking>(
    `SELECT id, thread_id, venue, customer_name, pax, proposed_slots, updated_at
       FROM inbox_bookings
      WHERE state = 'slots_proposed'
        AND nudged_at IS NULL
        AND updated_at < now() - make_interval(days => $1)
      ORDER BY updated_at
      LIMIT 5`,
    [NUDGE_AFTER_DAYS]
  )
  let nudged = 0
  for (const b of rows) {
    try {
      if (await nudgeBooking(b)) nudged++
    } catch (e) {
      console.error(
        `[followups] nudge for booking ${b.id} failed:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  return { nudged }
}

const INFO_FOLLOWUP_AFTER_DAYS = 4

interface QuietInfoThread {
  thread_id: string
  category: string
  customer_name: string | null
}

/**
 * Threads that received generic function info (we sent a reply with the pack /
 * options) but the customer went quiet. After INFO_FOLLOWUP_AFTER_DAYS, draft
 * ONE warm follow-up asking if there's anything we can do to help get the
 * function booked. Drafts only — never auto-sent. One per thread (guarded by
 * info_followed_up_at).
 */
export async function followUpQuietInfoThreads(): Promise<{ nudged: number }> {
  const { rows } = await db().query<QuietInfoThread>(
    `SELECT t.thread_id, t.category, COALESCE(b.customer_name, '') AS customer_name
       FROM inbox_threads t
       LEFT JOIN LATERAL (
         SELECT customer_name FROM inbox_bookings WHERE thread_id = t.thread_id ORDER BY id DESC LIMIT 1
       ) b ON true
      WHERE t.category IN ('events_tea_garden_functions','events_beach_house_functions')
        AND t.state IN ('sent_by_human','auto_sent')
        AND t.info_followed_up_at IS NULL
        AND t.last_processed_at < now() - make_interval(days => $1)
        AND NOT EXISTS (
          SELECT 1 FROM inbox_invoices i WHERE i.thread_id = t.thread_id AND i.invoice_number <> 'PENDING'
        )
        AND NOT EXISTS (
          SELECT 1 FROM inbox_bookings bk WHERE bk.thread_id = t.thread_id
            AND bk.state IN ('slot_selected','deposit_invoiced','deposit_paid','balance_invoiced','paid','cancelled')
        )
      ORDER BY t.last_processed_at
      LIMIT 5`,
    [INFO_FOLLOWUP_AFTER_DAYS]
  )
  let nudged = 0
  for (const t of rows) {
    try {
      if (await followUpInfoThread(t)) nudged++
    } catch (e) {
      console.error(`[followups] info follow-up for ${t.thread_id} failed:`, e instanceof Error ? e.message : e)
    }
  }
  return { nudged }
}

async function followUpInfoThread(t: QuietInfoThread): Promise<boolean> {
  const thread = await getThread(t.thread_id)
  if (!thread.messages.length) return false
  if (isTrashed(thread)) {
    // Deleted by staff — stamp the once-flag so it never re-selects.
    await db().query(`UPDATE inbox_threads SET info_followed_up_at = now() WHERE thread_id = $1`, [t.thread_id])
    await dismissTrashedThread(t.thread_id).catch(() => {})
    return false
  }
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const latest = thread.messages[thread.messages.length - 1]!
  // Only nudge when the ball is in the customer's court (we replied last).
  if (!latest.from.toLowerCase().includes(helloMail)) return false
  let lastCustomer: ParsedMessage | undefined
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (!m.from.toLowerCase().includes(helloMail)) {
      lastCustomer = m
      break
    }
  }
  if (!lastCustomer) return false

  const category = (t.category as Category) ?? "events_beach_house_functions"
  const playbook = await getPlaybook(category)
  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map((m) => ({
      from: m.from,
      date: m.date,
      text: m.bodyText.slice(0, 2000),
    })),
    customerName: t.customer_name || undefined,
    customExtras: [
      {
        role: "user",
        content:
          `We sent this customer our function information a few days ago and they haven't replied. Write a SHORT, warm, zero-pressure follow-up (2-3 sentences): check the info reached them, and ask if there's anything we can help with to get their function booked in (e.g. a date, numbers, or any questions). Don't re-attach the pack or repeat all the prices. One light nudge.`,
      },
    ],
  })
  if (!d.body) return false
  await deliverNudgeDraft(thread, lastCustomer, d.body)
  await db().query(`UPDATE inbox_threads SET info_followed_up_at = now() WHERE thread_id = $1`, [t.thread_id])
  console.log(`[followups] info follow-up drafted for ${t.thread_id} (${category})`)
  return true
}

async function nudgeBooking(b: StaleBooking): Promise<boolean> {
  const thread = await getThread(b.thread_id)
  if (!thread.messages.length) return false
  if (isTrashed(thread)) {
    // Deleted by staff — never nudge; stamp nudged_at so it stops re-selecting.
    await db().query(`UPDATE inbox_bookings SET nudged_at = now() WHERE id = $1`, [b.id])
    await dismissTrashedThread(b.thread_id).catch(() => {})
    return false
  }
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const latest = thread.messages[thread.messages.length - 1]!

  // Only nudge when the ball is in the customer's court. If their message is
  // the latest, the main pipeline owes them a reply instead.
  if (!latest.from.toLowerCase().includes(helloMail)) {
    return false
  }
  // Find the most recent customer message to reply to (threading headers).
  let lastCustomer: ParsedMessage | undefined
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!
    if (!m.from.toLowerCase().includes(helloMail)) {
      lastCustomer = m
      break
    }
  }
  if (!lastCustomer) return false

  // Re-check state right before drafting: a confirmation reply could have
  // progressed this booking (slot_selected/invoiced) between the SELECT and
  // now — nudging a booked customer would be confusing.
  const fresh = await db().query<{ state: string; nudged_at: Date | null }>(
    `SELECT state, nudged_at FROM inbox_bookings WHERE id = $1`,
    [b.id]
  )
  if (fresh.rows[0]?.state !== "slots_proposed" || fresh.rows[0]?.nudged_at) {
    return false
  }

  const category = CATEGORY_BY_VENUE[b.venue] ?? "events_beach_house_functions"
  const playbook = await getPlaybook(category)
  const slotsPast = b.proposed_slots.every(
    (s) => new Date(s.start).getTime() < Date.now()
  )
  const d = await draft({
    category,
    playbook,
    threadHistory: thread.messages.map((m) => ({
      from: m.from,
      date: m.date,
      text: m.bodyText.slice(0, 2000),
    })),
    customerName: b.customer_name ?? undefined,
    customExtras: [
      {
        role: "user",
        content:
          `The customer hasn't replied in a few days since we proposed function times. Write a SHORT, friendly, zero-pressure follow-up (2-3 sentences).\n` +
          (slotsPast
            ? `The dates we proposed have now passed — don't re-propose them; instead ask if they'd still like to lock something in and what dates suit.\n`
            : `Ask if any of the times we suggested work, or if they'd like other options.\n`) +
          `Don't repeat the full pitch or re-attach anything. One light nudge, then leave it with them.`,
      },
    ],
  })
  if (!d.body) return false
  await deliverNudgeDraft(thread, lastCustomer, d.body)
  await db().query(`UPDATE inbox_bookings SET nudged_at = now() WHERE id = $1`, [
    b.id,
  ])
  console.log(`[followups] nudge drafted for booking ${b.id} (${b.venue})`)
  return true
}
