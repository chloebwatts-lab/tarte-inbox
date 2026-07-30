// Dine-in booking confirmations: every NEW Now Book It booking with a guest
// email gets one short confirmation email asking the guest to acknowledge the
// location they booked (Tea Garden vs Restaurant). Tea Garden bookings on the
// regular menu are also asked up front whether they want high tea, because
// deciding on the day is subject to availability. Burleigh takes no bookings,
// so everything here is Beach House, Currumbin.
//
// Data reality (checked 2026-07-30): NBI's daily summary CSV has Email/Phone
// COLUMNS but every value is blank — NBI strips guest contact details from
// the export. Until that's enabled in NBI admin, this module records each new
// booking as 'skipped_no_email' and the digest says so. The moment emails
// appear in the CSV, sending starts automatically with no code change.
//
// Idempotency: one row per booking_ref in inbox_nbi_confirmations, inserted
// before send. A seed pass marks every booking that predates the feature as
// 'skipped_preexisting' so deploying never mass-emails the whole book.

import { db } from "../db/pool.js"
import { config } from "../config.js"
import {
  sendPlainEmail,
  getThread,
  applyLabel,
  archiveThread,
  markThreadRead,
} from "../google/gmail.js"
import { parseBookingAck } from "../llm/booking-ack.js"

export const CONFIRMATION_LABEL = "Tarte / Booking Confirmations"
const MAX_SENDS_PER_RUN = 40

export type ConfirmationVenue = "tea_garden_high_tea" | "tea_garden" | "restaurant"

interface CandidateBooking {
  booking_ref: string
  booking_date: string
  booking_time: string
  service: string
  pax: number
  first_name: string | null
  last_name: string | null
  email: string | null
  seat_location: string | null
  status: string
}

/** Where is this booking actually seated? seat_location is the guest's own
 * choice in the NBI widget, so it wins; service name is the fallback. */
export function classifyVenue(b: {
  service: string
  seat_location: string | null
}): ConfirmationVenue {
  if (/high tea/i.test(b.service)) return "tea_garden_high_tea"
  if (/tea garden/i.test(b.seat_location ?? "") || /tea garden/i.test(b.service))
    return "tea_garden"
  return "restaurant"
}

function prettyDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00+10:00`).toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
    day: "numeric",
    month: "long",
  })
}

function prettyTime(t: string): string {
  const [hStr, m] = t.split(":") as [string, string]
  const h = Number(hStr)
  const ampm = h >= 12 ? "pm" : "am"
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m}${ampm}`
}

/** Short, plain, Chloe-voice confirmation email. No em dashes anywhere. */
export function confirmationEmail(
  b: CandidateBooking,
  venue: ConfirmationVenue
): { subject: string; body: string } {
  const first = (b.first_name ?? "").trim() || "there"
  const when = `${prettyDate(b.booking_date)} at ${prettyTime(b.booking_time)}`
  const guests = `${b.pax} ${b.pax === 1 ? "guest" : "guests"}`

  const seatLine =
    venue === "tea_garden_high_tea"
      ? /tea garden/i.test(b.seat_location ?? "")
        ? "High Tea in the Tea Garden"
        : "High Tea"
      : venue === "tea_garden"
        ? "Tea Garden (next door to the restaurant)"
        : "Restaurant (main dining room)"

  const lines = [
    `Hi ${first},`,
    ``,
    `Thanks for booking with us at Tarte Beach House, Currumbin. Just confirming your details:`,
    ``,
    `${when}`,
    `${guests}`,
    `Seating: ${seatLine}`,
    ``,
  ]

  if (venue === "tea_garden") {
    lines.push(
      `One quick question: would you like high tea, or will you be ordering from the regular menu? High tea is prepared ahead of time, so if you would like it please let us know now. If you decide on the day it is subject to availability and we may not be able to offer it.`,
      ``
    )
    lines.push(
      `Could you reply to this email to confirm your booking and let us know about high tea? If anything above needs changing, just tell us here.`
    )
  } else {
    lines.push(
      `Could you reply to this email to confirm these details are right? If anything needs changing, just tell us here.`
    )
  }

  lines.push(``, `See you soon,`, `Tarte Beach House, Currumbin`)
  return {
    subject: `Please confirm your booking, ${prettyDate(b.booking_date)}`,
    body: lines.join("\n"),
  }
}

/** One-time seed: any booking already in the table when the feature first
 * runs is marked preexisting so we never email the historical book. */
async function seedIfFirstRun(): Promise<boolean> {
  const existing = await db().query(`SELECT 1 FROM inbox_nbi_confirmations LIMIT 1`)
  if (existing.rows.length) return false
  const r = await db().query(
    `INSERT INTO inbox_nbi_confirmations (booking_ref, state)
     SELECT booking_ref, 'skipped_preexisting' FROM inbox_nbi_bookings
     ON CONFLICT (booking_ref) DO NOTHING`
  )
  console.log(`[confirm] seed pass: marked ${r.rowCount} preexisting booking(s)`)
  return true
}

export interface ConfirmationRunResult {
  sent: number
  skippedNoEmail: number
}

export async function sendBookingConfirmations(): Promise<ConfirmationRunResult> {
  if (!config().ENABLE_BOOKING_CONFIRMATIONS) return { sent: 0, skippedNoEmail: 0 }
  const seeded = await seedIfFirstRun()
  if (seeded) return { sent: 0, skippedNoEmail: 0 }

  const { rows } = await db().query<CandidateBooking>(
    `SELECT b.booking_ref, b.booking_date::text, b.booking_time::text, b.service,
            b.pax, b.first_name, b.last_name, b.email, b.seat_location, b.status
       FROM inbox_nbi_bookings b
       LEFT JOIN inbox_nbi_confirmations c ON c.booking_ref = b.booking_ref
      WHERE c.booking_ref IS NULL
        AND b.booking_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
        AND b.status IN ('Unconfirmed', 'Confirmed')
      ORDER BY b.booking_date, b.booking_time
      LIMIT $1`,
    [MAX_SENDS_PER_RUN]
  )

  let sent = 0
  let skippedNoEmail = 0
  for (const b of rows) {
    const email = (b.email ?? "").trim()
    const venue = classifyVenue(b)
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      await db().query(
        `INSERT INTO inbox_nbi_confirmations (booking_ref, state, venue)
         VALUES ($1, 'skipped_no_email', $2)
         ON CONFLICT (booking_ref) DO NOTHING`,
        [b.booking_ref, venue]
      )
      skippedNoEmail++
      continue
    }
    try {
      // Claim the row BEFORE sending so a crash mid-loop can't double-email.
      const claimed = await db().query(
        `INSERT INTO inbox_nbi_confirmations (booking_ref, state, venue, guest_email)
         VALUES ($1, 'sending', $2, $3)
         ON CONFLICT (booking_ref) DO NOTHING`,
        [b.booking_ref, venue, email]
      )
      if (!claimed.rowCount) continue
      const { subject, body } = confirmationEmail(b, venue)
      const r = await sendPlainEmail(
        email,
        subject,
        body,
        config().HELLO_MAILBOX,
        "Tarte Beach House, Currumbin"
      )
      await db().query(
        `UPDATE inbox_nbi_confirmations
            SET state = 'sent', message_id = $2, thread_id = $3, sent_at = now()
          WHERE booking_ref = $1`,
        [b.booking_ref, r.id, r.threadId]
      )
      if (r.threadId) {
        await applyLabel(r.threadId, CONFIRMATION_LABEL).catch(() => {})
      }
      sent++
      console.log(
        `[confirm] sent booking confirmation ${b.booking_ref} (${venue}) to ${email}`
      )
    } catch (e) {
      // Leave the claimed row in 'sending' — visible in the digest as stuck,
      // and never retried into a double-send.
      console.error(
        `[confirm] send failed for ${b.booking_ref}:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  if (sent || skippedNoEmail)
    console.log(`[confirm] sent=${sent} no_email=${skippedNoEmail}`)
  return { sent, skippedNoEmail }
}

/** Is this Gmail thread one of our confirmation threads? Used by the pipeline
 * to intercept guest replies before normal classification. */
export async function confirmationForThread(
  threadId: string
): Promise<{ booking_ref: string; venue: string | null; state: string } | null> {
  const r = await db().query<{ booking_ref: string; venue: string | null; state: string }>(
    `SELECT booking_ref, venue, state FROM inbox_nbi_confirmations WHERE thread_id = $1`,
    [threadId]
  )
  return r.rows[0] ?? null
}

/** Record a guest's reply on a confirmation thread. Plain acknowledgements are
 * labelled + archived (nothing for staff to do). Replies that ask a question,
 * request a change, or want high tea stay in the inbox for the normal
 * pipeline, and high-tea requests are surfaced in the digest. Returns true
 * when the thread is fully handled (pipeline should stop). */
export async function handleConfirmationReply(threadId: string): Promise<boolean> {
  const row = await confirmationForThread(threadId)
  if (!row) return false
  const thread = await getThread(threadId)
  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const guestMsgs = thread.messages.filter(
    (m) => !m.from.toLowerCase().includes(helloMail)
  )
  const latest = guestMsgs[guestMsgs.length - 1]
  if (!latest) return false

  const parsed = await parseBookingAck(
    guestMsgs.map((m) => m.bodyText.slice(0, 1500)).join("\n\n---\n\n"),
    row.venue === "tea_garden"
  )

  await db().query(
    `UPDATE inbox_nbi_confirmations
        SET state = CASE WHEN $2 THEN 'acknowledged' ELSE state END,
            acknowledged_at = COALESCE(acknowledged_at, CASE WHEN $2 THEN now() END),
            high_tea_answer = COALESCE($3, high_tea_answer),
            ack_summary = $4
      WHERE booking_ref = $1`,
    [row.booking_ref, parsed.acknowledged, parsed.high_tea, parsed.summary]
  )

  const fullyHandled = parsed.acknowledged && !parsed.needs_reply
  if (fullyHandled) {
    // Nothing for staff to do. High-tea yes still shows up in the digest so
    // the kitchen preps for it and staff note it on the NBI booking.
    await markThreadRead(threadId).catch(() => {})
    await archiveThread(threadId).catch(() => {})
    console.log(
      `[confirm] ack recorded for ${row.booking_ref} (high tea: ${parsed.high_tea ?? "n/a"})`
    )
  }
  return fullyHandled
}

/** Digest data: last 24h of confirmation activity + anything stuck. */
export async function confirmationDigestStats(): Promise<{
  sent24h: Array<{
    booking_ref: string
    booking_date: string
    booking_time: string
    first_name: string | null
    last_name: string | null
    pax: number
    venue: string | null
    state: string
    high_tea_answer: string | null
  }>
  acked24h: Array<{
    booking_ref: string
    booking_date: string
    first_name: string | null
    last_name: string | null
    pax: number
    venue: string | null
    high_tea_answer: string | null
    ack_summary: string | null
  }>
  awaitingSoon: number
  highTeaYesUpcoming: Array<{
    booking_date: string
    booking_time: string
    first_name: string | null
    last_name: string | null
    pax: number
  }>
  newNoEmail24h: number
}> {
  const sent24h = (
    await db().query(
      `SELECT c.booking_ref, b.booking_date::text, b.booking_time::text,
              b.first_name, b.last_name, b.pax, c.venue, c.state, c.high_tea_answer
         FROM inbox_nbi_confirmations c
         JOIN inbox_nbi_bookings b USING (booking_ref)
        WHERE c.sent_at > now() - interval '24 hours'
        ORDER BY b.booking_date, b.booking_time`
    )
  ).rows
  const acked24h = (
    await db().query(
      `SELECT c.booking_ref, b.booking_date::text, b.first_name, b.last_name,
              b.pax, c.venue, c.high_tea_answer, c.ack_summary
         FROM inbox_nbi_confirmations c
         JOIN inbox_nbi_bookings b USING (booking_ref)
        WHERE c.acknowledged_at > now() - interval '24 hours'
        ORDER BY b.booking_date`
    )
  ).rows
  const awaitingSoon =
    (
      await db().query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM inbox_nbi_confirmations c
           JOIN inbox_nbi_bookings b USING (booking_ref)
          WHERE c.state = 'sent'
            AND b.status NOT IN ('Cancelled')
            AND b.booking_date BETWEEN (now() AT TIME ZONE 'Australia/Brisbane')::date
                                   AND (now() AT TIME ZONE 'Australia/Brisbane')::date + 3`
      )
    ).rows[0]?.n ?? 0
  const highTeaYesUpcoming = (
    await db().query(
      `SELECT b.booking_date::text, b.booking_time::text, b.first_name, b.last_name, b.pax
         FROM inbox_nbi_confirmations c
         JOIN inbox_nbi_bookings b USING (booking_ref)
        WHERE c.high_tea_answer = 'yes'
          AND b.status NOT IN ('Cancelled')
          AND b.booking_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
        ORDER BY b.booking_date, b.booking_time`
    )
  ).rows
  const newNoEmail24h =
    (
      await db().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM inbox_nbi_confirmations
          WHERE state = 'skipped_no_email' AND created_at > now() - interval '24 hours'`
      )
    ).rows[0]?.n ?? 0
  return { sent24h, acked24h, awaitingSoon, highTeaYesUpcoming, newNoEmail24h }
}
