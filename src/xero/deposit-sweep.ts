// Deposit landed, nobody typed it. Hourly: for every live event invoice with
// no money recorded, look for the deposit (or the whole total) in two places
// Louise already keeps up to date: the Xero bank feed (reconciled RECEIVE
// transactions) and the Xero invoice itself (payments or prepayments she
// applied). A confirmed hit records the payment and puts it on the invoice
// quietly. The remaining-balance invoice is built and its email drafted in
// hello@ 14 days before the event (or at once if the event is closer), so
// the girls get it when they would send it, not weeks early.
//
// Until 2026-10-15 none of this happened unless staff typed "amount paid" on
// the edit page or the customer emailed "I've paid" (Georgia expected Xero to
// do it, Chloe 15 Oct). Same proof standard as the digest: amount + payer
// name overlap, or amount + our invoice number in the transfer reference.
// Amount alone is never enough.

import { db } from "../db/pool.js"
import { getBookingByThread, updateBooking } from "../db/queries.js"
import type { InvoiceExtraction } from "../invoice/from-thread.js"
import { lineItemsFromExtraction, isSaveTheDate, buildInvoiceFromExtraction } from "../invoice/from-thread.js"
import { findAmount, nameOverlap } from "./event-payments.js"
import {
  listIncomingBankTransactions,
  xeroBankMatchReady,
  xeroInvoiceSnapshot,
  type MatchedPayment,
} from "./client.js"

interface Candidate {
  thread_id: string
  invoice_number: string
  customer_name: string | null
  editable: InvoiceExtraction
  xero_invoice_id: string | null
  has_balance: boolean
  verified_sum: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

function todayBrisbane(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(new Date())
}

/** What we expect to see land for this invoice: the whole total, or the
 * deposit (fixed save-the-date amount, else the percentage). */
export function expectedAmounts(x: InvoiceExtraction): { total: number; deposit: number } {
  const total = round2(lineItemsFromExtraction(x).reduce((s, li) => s + li.qty * li.unitPrice, 0))
  const deposit = isSaveTheDate(x) ? total : round2((total * (x.deposit_pct ?? 50)) / 100)
  return { total, deposit }
}

/** Bank-feed match for an invoice: the total first (people often pay the lot),
 * then the deposit. Confirmed only: payer name overlaps the customer, or the
 * transfer reference quotes our invoice number. */
export function matchDeposit(
  txns: MatchedPayment[],
  x: InvoiceExtraction,
  invoiceNumbers: string[],
  usedTxnIds: Set<string>
): { txn: MatchedPayment; amount: number } | null {
  const { total, deposit } = expectedAmounts(x)
  const fresh = txns.filter((t) => !usedTxnIds.has(t.bankTransactionId))
  const nums = invoiceNumbers.map((n) => n.toLowerCase())
  for (const amount of [total, deposit]) {
    if (amount <= 0) continue
    const byRef = fresh.find(
      (t) => Math.abs(t.total - amount) < 0.01 && nums.some((n) => t.reference.toLowerCase().includes(n))
    )
    if (byRef) return { txn: byRef, amount }
    const byName = findAmount(fresh, amount, x.customer_name)
    if (byName?.confirmed && nameOverlap(x.customer_name, byName.txn.contactName)) return { txn: byName.txn, amount }
  }
  return null
}

async function candidates(): Promise<Candidate[]> {
  const { rows } = await db().query<Candidate & { verified_sum: string | null }>(
    `SELECT i.thread_id, i.invoice_number, i.customer_name, i.editable, i.xero_invoice_id,
            EXISTS (SELECT 1 FROM inbox_invoices b WHERE b.thread_id = i.thread_id AND b.kind = 'balance' AND b.invoice_number <> 'PENDING') AS has_balance,
            (SELECT COALESCE(SUM(p.amount), 0) FROM inbox_payments p
              WHERE p.status = 'verified' AND p.invoice_number IN
                (SELECT invoice_number FROM inbox_invoices WHERE thread_id = i.thread_id)) AS verified_sum,
            b.state AS booking_state
       FROM inbox_invoices i
       LEFT JOIN LATERAL (
         SELECT state FROM inbox_bookings WHERE thread_id = i.thread_id ORDER BY id DESC LIMIT 1
       ) b ON TRUE
      WHERE i.kind = 'standard'
        AND i.invoice_number <> 'PENDING'
        AND i.editable IS NOT NULL
        AND i.thread_id IS NOT NULL AND i.thread_id <> ''
        AND (i.thread_id NOT LIKE 'fn:%' OR i.drafted_at IS NOT NULL)
        AND COALESCE(NULLIF(i.editable->>'amount_paid', '')::float, 0) <= 0
        AND (i.editable->>'event_date') ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND (i.editable->>'event_date')::date >= (now() AT TIME ZONE 'Australia/Brisbane')::date - 7
        AND COALESCE(b.state, '') <> 'cancelled'
      ORDER BY i.id`
  )
  return rows.map((r) => ({ ...r, verified_sum: Number(r.verified_sum ?? 0) }))
}

const BALANCE_DAYS_BEFORE = 14

function daysUntil(isoDate: string): number {
  const today = todayBrisbane()
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000)
}

/** Record the money on every invoice row of the thread and rebuild the PDFs
 * quietly (no email). A save-the-date hold stops there: the package invoice
 * that follows carries the amount forward. A deposit on a package invoice
 * gets its balance invoice drafted when the event is close (see
 * draftBalanceInvoice), or now if it already is. */
async function applyReceived(c: Candidate, received: number, how: string): Promise<string> {
  const x: InvoiceExtraction = { ...c.editable, amount_paid: received }
  const { total } = expectedAmounts(x)
  const paidInFull = received >= total - 0.005
  const booking = await getBookingByThread(c.thread_id).catch(() => null)
  if (booking) await updateBooking(booking.id, { state: paidInFull ? "paid" : "deposit_paid" }).catch(() => {})
  await db().query(
    `UPDATE inbox_invoices SET editable = editable || jsonb_build_object('amount_paid', $2::float)
      WHERE thread_id = $1 AND editable IS NOT NULL`,
    [c.thread_id, received]
  )
  if (isSaveTheDate(x)) {
    console.log(`[deposits] ${c.invoice_number}: save-the-date $${received.toFixed(2)} received (${how}), date held`)
    return "held"
  }
  if (c.thread_id.startsWith("fn:")) {
    const { upsertFunctionInvoice } = await import("../functions-api.js")
    const r = await upsertFunctionInvoice(c.thread_id.slice(3), "deposit", { amount_paid: received })
    if (!r.ok) throw new Error(r.error)
  } else {
    await buildInvoiceFromExtraction(x, { bookingId: booking?.id ?? null, threadId: c.thread_id, todayBrisbane: todayBrisbane(), kind: "standard" })
  }
  if (paidInFull) {
    console.log(`[deposits] ${c.invoice_number}: paid in full $${received.toFixed(2)} (${how})`)
    return "paid"
  }
  console.log(`[deposits] ${c.invoice_number}: deposit $${received.toFixed(2)} received (${how})`)
  if (c.has_balance || daysUntil(x.event_date!) <= BALANCE_DAYS_BEFORE) {
    await draftBalanceInvoice(c.thread_id, x, booking?.id ?? null)
    return "balance drafted"
  }
  return "deposit recorded"
}

/** Build (or refresh) the remaining-balance invoice for a thread whose
 * deposit is in, and put the email draft with it in hello@. */
async function draftBalanceInvoice(threadId: string, x: InvoiceExtraction, bookingId: number | null): Promise<string> {
  const received = round2(x.amount_paid ?? 0)
  const { total } = expectedAmounts(x)
  const balance = round2(total - received)
  const first = (x.customer_name ?? "there").split(/\s+/)[0]
  const body =
    `Hi ${first},\n\n` +
    `Thank you, your deposit of $${received.toFixed(2)} has been received and your date is locked in. ` +
    `Please find your remaining balance invoice attached. The balance of $${balance.toFixed(2)} is due 2 days prior to the event, along with your final numbers and dietaries.\n\n` +
    `Kind Regards,\nTarte Management`
  if (threadId.startsWith("fn:")) {
    const { upsertFunctionInvoice, draftFunctionInvoiceEmail } = await import("../functions-api.js")
    const r = await upsertFunctionInvoice(threadId.slice(3), "balance", { amount_paid: received })
    if (!r.ok) throw new Error(r.error)
    const d = await draftFunctionInvoiceEmail(r.invoice.invoice_number, { body })
    if (!d.ok) throw new Error(d.error)
    console.log(`[deposits] balance ${r.invoice.invoice_number} drafted ($${balance.toFixed(2)} owing, functions app)`)
    return r.invoice.invoice_number
  }
  const built = await buildInvoiceFromExtraction(x, { bookingId, threadId, todayBrisbane: todayBrisbane(), kind: "balance" })
  const { regenerateInvoiceFromEdits } = await import("../pipeline.js")
  const r = await regenerateInvoiceFromEdits(built.invoiceNumber, { amount_paid: received }, { body })
  if (!r.ok) throw new Error(r.error)
  console.log(`[deposits] balance ${built.invoiceNumber} drafted ($${balance.toFixed(2)} owing)`)
  return built.invoiceNumber
}

/** Deposits already in, event within two weeks, no balance invoice yet. */
async function balancesDue(): Promise<Array<{ thread_id: string; invoice_number: string; customer_name: string | null; editable: InvoiceExtraction }>> {
  const { rows } = await db().query<{ thread_id: string; invoice_number: string; customer_name: string | null; editable: InvoiceExtraction }>(
    `SELECT i.thread_id, i.invoice_number, i.customer_name, i.editable
       FROM inbox_invoices i
       LEFT JOIN LATERAL (
         SELECT state FROM inbox_bookings WHERE thread_id = i.thread_id ORDER BY id DESC LIMIT 1
       ) b ON TRUE
      WHERE i.kind = 'standard'
        AND i.invoice_number <> 'PENDING'
        AND i.editable IS NOT NULL
        AND i.thread_id IS NOT NULL AND i.thread_id <> ''
        AND (i.thread_id NOT LIKE 'fn:%' OR i.drafted_at IS NOT NULL)
        AND COALESCE(NULLIF(i.editable->>'amount_paid', '')::float, 0) > 0
        AND (i.editable->>'event_date') ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND (i.editable->>'event_date')::date BETWEEN (now() AT TIME ZONE 'Australia/Brisbane')::date
                                                 AND (now() AT TIME ZONE 'Australia/Brisbane')::date + ${BALANCE_DAYS_BEFORE}
        AND NOT EXISTS (SELECT 1 FROM inbox_invoices x WHERE x.thread_id = i.thread_id AND x.kind = 'balance' AND x.invoice_number <> 'PENDING')
        AND COALESCE(b.state, '') <> 'cancelled'
      ORDER BY i.id`
  )
  return rows
}

async function recordPayment(c: Candidate, amount: number, txnId: string | null, note: string): Promise<void> {
  await db().query(
    `INSERT INTO inbox_payments (thread_id, invoice_number, amount, status, matched_txn_id, matched_reference, verified_at, confirmation_drafted_at)
     SELECT $1, $2, $3, 'verified', $4, $5, now(), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM inbox_payments WHERE invoice_number = $2 AND abs(amount - $3) < 0.01 AND status = 'verified'
      )`,
    [c.thread_id, c.invoice_number, amount, txnId, note]
  )
}

export async function sweepDepositsLanded(
  opts: { dryRun?: boolean } = {}
): Promise<{ checked: number; landed: number; preview: string[] }> {
  const list = await candidates()
  const preview: string[] = []
  if (!list.length) return { checked: 0, landed: 0, preview }
  let txns: MatchedPayment[] = []
  const bankReady = await xeroBankMatchReady().catch(() => false)
  if (bankReady) {
    try {
      txns = await listIncomingBankTransactions(120)
    } catch (e) {
      console.error("[deposits] bank feed unavailable:", e instanceof Error ? e.message : e)
    }
  }
  const used = new Set<string>(
    (await db().query<{ matched_txn_id: string }>(`SELECT matched_txn_id FROM inbox_payments WHERE matched_txn_id IS NOT NULL`)).rows.map(
      (r) => r.matched_txn_id
    )
  )
  let landed = 0
  const who = (c: Candidate): string => `${c.invoice_number} ${c.customer_name ?? "?"} (event ${c.editable.event_date})`
  for (const c of list) {
    try {
      const { total, deposit } = expectedAmounts(c.editable)
      // 1. Already verified by an earlier sweep or a customer's "I've paid"
      //    email, but never put on the invoice.
      if (c.verified_sum > 0) {
        preview.push(`${who(c)}: $${c.verified_sum.toFixed(2)} verified earlier, not yet on the invoice`)
        if (!opts.dryRun) preview[preview.length - 1] += ` -> ${await applyReceived(c, round2(c.verified_sum), "verified earlier")}`
        landed++
        continue
      }
      // 2. Louise applied money to the Xero invoice (payment or prepayment).
      if (c.xero_invoice_id) {
        const snap = await xeroInvoiceSnapshot(c.xero_invoice_id).catch(() => null)
        if (snap && snap.amountPaid > 0) {
          const amt = round2(snap.amountPaid)
          preview.push(`${who(c)}: $${amt.toFixed(2)} applied on the Xero invoice (${snap.status})`)
          if (!opts.dryRun) {
            await recordPayment(c, amt, null, `applied on Xero invoice (${snap.status})`)
            preview[preview.length - 1] += ` -> ${await applyReceived(c, amt, "applied in Xero")}`
          }
          landed++
          continue
        }
      }
      // 3. The bank feed shows it.
      const nums = (
        await db().query<{ invoice_number: string }>(
          `SELECT invoice_number FROM inbox_invoices WHERE thread_id = $1 AND invoice_number <> 'PENDING'`,
          [c.thread_id]
        )
      ).rows.map((r) => r.invoice_number)
      const hit = matchDeposit(txns, c.editable, nums, used)
      if (!hit) {
        preview.push(`${who(c)}: nothing yet (expecting $${deposit.toFixed(2)} deposit or $${total.toFixed(2)} total)`)
        continue
      }
      used.add(hit.txn.bankTransactionId)
      preview.push(`${who(c)}: $${hit.amount.toFixed(2)} in bank feed from "${hit.txn.contactName}" on ${hit.txn.date.slice(0, 10)}`)
      if (opts.dryRun) {
        landed++
        continue
      }
      await recordPayment(
        c,
        hit.amount,
        hit.txn.bankTransactionId,
        `${hit.txn.contactName} $${hit.amount.toFixed(2)} on ${hit.txn.date.slice(0, 10)} (deposit sweep)`
      )
      preview[preview.length - 1] += ` -> ${await applyReceived(c, hit.amount, `bank feed, ${hit.txn.contactName} ${hit.txn.date.slice(0, 10)}`)}`
      landed++
    } catch (e) {
      console.error(`[deposits] ${c.invoice_number} failed:`, e instanceof Error ? e.message : e)
    }
  }
  // Balance invoices for deposits already in, once the event is close.
  for (const b of await balancesDue()) {
    const { total } = expectedAmounts(b.editable)
    const received = round2(b.editable.amount_paid ?? 0)
    if (received >= total - 0.005 || isSaveTheDate(b.editable)) continue
    preview.push(`${b.invoice_number} ${b.customer_name ?? "?"} (event ${b.editable.event_date}): balance $${round2(total - received).toFixed(2)} due, drafting the balance invoice`)
    if (opts.dryRun) continue
    try {
      const booking = await getBookingByThread(b.thread_id).catch(() => null)
      await draftBalanceInvoice(b.thread_id, b.editable, booking?.id ?? null)
    } catch (e) {
      console.error(`[deposits] balance for ${b.invoice_number} failed:`, e instanceof Error ? e.message : e)
    }
  }
  return { checked: list.length, landed, preview }
}
