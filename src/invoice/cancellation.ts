import { db } from "../db/pool.js"
import { getBookingByThread, updateBooking } from "../db/queries.js"
import { ensureLabel, listThreadsByLabel, removeLabel, sendPlainEmail } from "../google/gmail.js"
import { config } from "../config.js"

/** Staff apply this label in Gmail to a function thread when the customer
 * cancels (or no-shows and the booking is being written off). Deterministic
 * on purpose — cancelling books money, so a human pulls the trigger. */
export const CANCEL_FUNCTION_LABEL = "Tarte / Cancel Function"

/** Ops notices about event money go to Louise with Chloe in the loop. */
const STAFF_NOTICE_RECIPIENTS = ["accounts@tarte.com.au", "chloe@tarte.com.au"]

export async function notifyStaff(subject: string, body: string): Promise<void> {
  const c = config()
  for (const to of STAFF_NOTICE_RECIPIENTS) {
    try {
      await sendPlainEmail(to, subject, body, c.HELLO_MAILBOX, "Tarte Events Accounting")
    } catch (e) {
      console.error(`[cancel] notice to ${to} failed:`, e instanceof Error ? e.message : e)
    }
  }
}

interface InvoiceRow {
  invoice_number: string
  amount: string
  customer_name: string | null
  xero_invoice_id: string | null
}

/** The deposit rule, spelled out once. Matt's regime: income belongs to the
 * event date; a forfeited deposit becomes income on the CANCELLATION date. */
function depositInstructions(action: string): string {
  return [
    `Deposit handling (needs Chloe's call, then Louise's hands):`,
    `- REFUND: pay the deposit back from the bank, then remove the Xero prepayment so nothing is left hanging on the contact.`,
    `- FORFEIT: keep the money — apply the prepayment to income dated the CANCELLATION date (not the event date), coded to Event Sales.`,
    action === "manual"
      ? `Note: this invoice already has money applied in Xero, so it was left untouched — sort the deposit before voiding or crediting anything.`
      : `The Xero invoice itself has been ${action} automatically.`,
  ].join("\n")
}

/** Process threads labelled "Tarte / Cancel Function": mark the booking
 * cancelled (the hourly calendar sync then drops the calendar hold), clean up
 * the Xero draft, and send Louise + Chloe exact instructions. */
export async function runCancellations(): Promise<{ processed: number }> {
  await ensureLabel(CANCEL_FUNCTION_LABEL).catch(() => {})
  const ids = await listThreadsByLabel(CANCEL_FUNCTION_LABEL)
  let processed = 0
  for (const threadId of ids) {
    try {
      const booking = await getBookingByThread(threadId)
      const inv = await db().query<InvoiceRow>(
        `SELECT invoice_number, amount, customer_name, xero_invoice_id
           FROM inbox_invoices WHERE thread_id = $1 ORDER BY id DESC`,
        [threadId]
      )
      const latest = inv.rows[0]
      if (booking && booking.state !== "cancelled") {
        await updateBooking(booking.id, { state: "cancelled" })
      }
      let xeroLine = "No Xero invoice existed for this event."
      let action = "none"
      const xeroId = inv.rows.find((r) => r.xero_invoice_id)?.xero_invoice_id
      if (xeroId) {
        const { cancelEventInvoice } = await import("../xero/client.js")
        const r = await cancelEventInvoice(xeroId)
        action = r.action
        xeroLine =
          r.action === "manual"
            ? `Xero invoice left AS IS (status ${r.status}, $${r.amountPaid.toFixed(2)} applied) — needs manual handling.`
            : `Xero invoice ${r.action.toUpperCase()} (was ${r.status}).`
      }
      const who = latest?.customer_name ?? booking?.customer_name ?? "unknown customer"
      const evDate = booking?.event_date
        ? new Date(booking.event_date).toISOString().slice(0, 10)
        : "unknown date"
      const depositTaken = booking
        ? ["deposit_paid", "balance_invoiced", "paid"].includes(booking.state)
        : false
      await notifyStaff(
        `Function CANCELLED — ${latest?.invoice_number ?? threadId} (${who})`,
        [
          `The function for ${who} (event date ${evDate}) has been cancelled via the "${CANCEL_FUNCTION_LABEL}" label.`,
          ``,
          `Booking marked cancelled — the calendar hold will drop on the next sync.`,
          xeroLine,
          ``,
          depositTaken
            ? depositInstructions(action)
            : `No deposit appears to have been received (booking never reached deposit_paid). If money WAS received outside the system, treat it per the deposit rule: refund it, or forfeit it as income dated today.`,
          ``,
          `Customer reply, if any, stays with staff — nothing has been sent to the customer.`,
        ].join("\n")
      )
      processed++
    } catch (e) {
      console.error(`[cancel] thread ${threadId} failed:`, e instanceof Error ? e.message : e)
    } finally {
      await removeLabel(threadId, CANCEL_FUNCTION_LABEL).catch(() => {})
    }
  }
  return { processed }
}

interface SweepRow {
  thread_id: string
  invoice_number: string
  customer_name: string | null
  event_date: string
  xero_invoice_id: string | null
  booking_state: string | null
}

/** Day-after-event sweep: any invoiced event whose date has passed but whose
 * booking never reached paid (and wasn't cancelled) gets ONE flag email to
 * Louise + Chloe — approve the Xero draft, apply the money, chase the
 * balance, or no-show it via the cancel label. Keys off the INVOICE
 * extraction's event_date (booking rows rarely carry one); each thread is
 * flagged exactly once. */
export async function runPostEventSweep(): Promise<{ flagged: number }> {
  const rows = await db().query<SweepRow>(
    `SELECT DISTINCT ON (i.thread_id)
            i.thread_id, i.invoice_number, i.customer_name,
            (i.editable->>'event_date') AS event_date,
            i.xero_invoice_id, b.state AS booking_state
       FROM inbox_invoices i
       LEFT JOIN LATERAL (
         SELECT state FROM inbox_bookings WHERE thread_id = i.thread_id
          ORDER BY id DESC LIMIT 1
       ) b ON TRUE
      WHERE i.thread_id <> ''
        AND (i.editable->>'event_date') ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND (i.editable->>'event_date')::date < (now() AT TIME ZONE 'Australia/Brisbane')::date
        AND i.post_event_flagged_at IS NULL
        AND COALESCE(b.state, '') NOT IN ('cancelled', 'paid')
      ORDER BY i.thread_id, i.id DESC`
  )
  if (!rows.rows.length) return { flagged: 0 }
  const lines = rows.rows.map((r) => {
    const who = r.customer_name ?? r.invoice_number
    return [
      `• ${who} — event ${r.event_date}${r.booking_state ? `, booking state: ${r.booking_state}` : ""}`,
      `  Invoice ${r.invoice_number}${r.xero_invoice_id ? " (in Xero)" : " (NOT in Xero)"}`,
      `  To do: approve the Xero draft if still DRAFT, apply the prepayment + any final payment against it,`,
      `  chase the balance if unpaid, or if it was a no-show apply the "${CANCEL_FUNCTION_LABEL}" label to the thread.`,
    ].join("\n")
  })
  await notifyStaff(
    `Events finished but not settled — ${rows.rows.length} to close out`,
    [
      `These events have passed but were never marked settled. Under the new event-date accounting each needs closing out so the income lands in the right month:`,
      ``,
      lines.join("\n\n"),
      ``,
      `Each event is only flagged once — this is the complete current list.`,
    ].join("\n")
  )
  await db().query(
    `UPDATE inbox_invoices SET post_event_flagged_at = now() WHERE thread_id = ANY($1::text[])`,
    [rows.rows.map((r) => r.thread_id)]
  )
  return { flagged: rows.rows.length }
}
