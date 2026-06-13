// Booking follow-ups: customers who were proposed function slots and went
// quiet get ONE friendly nudge draft after NUDGE_AFTER_DAYS. Drafts only —
// never auto-sent — so a human always eyeballs the nudge before it goes.

import { getThread, type ParsedMessage } from "./google/gmail.js"
import { draft } from "./llm/drafter.js"
import { getPlaybook } from "./db/queries.js"
import { db } from "./db/pool.js"
import { config } from "./config.js"
import { deliverNudgeDraft } from "./pipeline.js"
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

async function nudgeBooking(b: StaleBooking): Promise<boolean> {
  const thread = await getThread(b.thread_id)
  if (!thread.messages.length) return false
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
