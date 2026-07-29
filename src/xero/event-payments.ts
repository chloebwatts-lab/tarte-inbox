// Running money view for the girls: which event deposits and balances have
// actually LANDED per the Xero bank feed. Rendered into the daily digest and
// used to auto-verify recorded payment claims. One bank pull per run.
//
// Ground rules:
// - inbox_payments rows with status='verified' are trusted as received.
// - For anything still expected we scan the bank feed by exact amount, and
//   prefer a payer-name overlap with the customer (people pay under maiden
//   names and company names — Jenna Strauch paid as "Jenna Elise Roche",
//   Teresa Gerada as "Qwando Pty Ltd" — so an amount-only match still counts,
//   it just gets labelled with the payer we saw).
// - The feed only shows RECONCILED transactions, so the section always states
//   how fresh the feed is; "not seen yet" a few days after a customer says
//   they've paid usually means Louise hasn't reconciled, not non-payment.

import { db } from "../db/pool.js"
import {
  listIncomingBankTransactions,
  xeroBankMatchReady,
  type MatchedPayment,
} from "./client.js"

interface EventRow {
  thread_id: string
  invoice_number: string
  kind: "standard" | "balance"
  customer_name: string | null
  amount: number
  event_date: string
  amount_paid: number | null
  deposit_pct: number | null
}

interface PaidRow {
  invoice_number: string
  amount: number
  status: string
  matched_reference: string | null
}

function nameOverlap(customer: string | null, payer: string): boolean {
  if (!customer || !payer) return false
  const a = customer.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2)
  const b = payer.toLowerCase()
  return a.some((w) => b.includes(w))
}

function fmtAud(n: number): string {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDay(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00+10:00`).toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

/** Match an expected amount against the bank feed. A confirmed match REQUIRES
 * a payer-name overlap with the customer — amount alone is nowhere near
 * enough ($880 matched the cash-register takings, $265 matched another
 * customer's cake, first version of this file). An amount-only hit from a
 * non-generic payer is surfaced as a "possible" for humans, never persisted. */
const GENERIC_PAYERS = /cash deposit|lightspeed|stripe|westpac|payclear|square|paypal/i

function findAmount(
  txns: MatchedPayment[],
  amount: number,
  customer: string | null
): { txn: MatchedPayment; confirmed: boolean } | null {
  if (amount <= 0) return null
  const hits = txns.filter((t) => Math.abs(t.total - amount) < 0.01)
  if (!hits.length) return null
  const named = hits.find((t) => nameOverlap(customer, t.contactName))
  if (named) return { txn: named, confirmed: true }
  const plausible = hits.find((t) => t.contactName && !GENERIC_PAYERS.test(t.contactName))
  if (plausible) return { txn: plausible, confirmed: false }
  return null
}

/** Persist a bank match as a verified payment row (idempotent by invoice +
 * amount). confirmation_drafted_at is set so the pipeline never auto-drafts
 * a confirmation off the back of a digest sweep. */
async function recordVerified(
  threadId: string,
  invoiceNumber: string,
  amount: number,
  note: string
): Promise<void> {
  await db().query(
    `INSERT INTO inbox_payments (thread_id, invoice_number, amount, status, verified_at, matched_reference, confirmation_drafted_at)
     SELECT $1, $2, $3, 'verified', now(), $4, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM inbox_payments
         WHERE invoice_number = $2 AND abs(amount - $3) < 0.01 AND status = 'verified'
      )`,
    [threadId, invoiceNumber, amount, note]
  )
}

/** Build the digest section. Empty string when there's nothing to report or
 * the bank scope isn't granted. */
export async function eventPaymentsDigestSection(): Promise<string> {
  if (!(await xeroBankMatchReady())) return ""
  // One invoice row per event thread: prefer the balance invoice's editable
  // (latest numbers), fall back to the standard one.
  const { rows } = await db().query<EventRow>(
    `SELECT DISTINCT ON (i.thread_id)
            i.thread_id, i.invoice_number, i.kind, i.customer_name,
            i.amount::float AS amount,
            i.editable->>'event_date' AS event_date,
            NULLIF(i.editable->>'amount_paid','')::float AS amount_paid,
            NULLIF(i.editable->>'deposit_pct','')::float AS deposit_pct
       FROM inbox_invoices i
      WHERE i.invoice_number <> 'PENDING'
        AND i.thread_id IS NOT NULL AND i.thread_id <> ''
        AND (i.editable->>'event_date') IS NOT NULL
        AND (i.editable->>'event_date') >= to_char(now() AT TIME ZONE 'Australia/Brisbane' - interval '5 days', 'YYYY-MM-DD')
      ORDER BY i.thread_id, (i.kind = 'balance') DESC, i.id DESC`
  )
  if (!rows.length) return ""

  let txns: MatchedPayment[]
  try {
    txns = await listIncomingBankTransactions(120)
  } catch (e) {
    return `💰 Event payments: Xero bank feed unavailable (${e instanceof Error ? e.message : "error"}).`
  }
  const feedTo = txns[0]?.date ? fmtDay(txns[0].date) : "unknown"

  const paid = await db().query<PaidRow>(
    `SELECT invoice_number, amount::float AS amount, status, matched_reference
       FROM inbox_payments WHERE status = 'verified'`
  )
  const verifiedByInvoice = new Map<string, PaidRow[]>()
  for (const p of paid.rows) {
    const list = verifiedByInvoice.get(p.invoice_number) ?? []
    list.push(p)
    verifiedByInvoice.set(p.invoice_number, list)
  }

  const lines: string[] = []
  for (const ev of rows.sort((a, b) => a.event_date.localeCompare(b.event_date))) {
    // Everything verified against EITHER invoice kind on this thread.
    const { rows: threadInvoices } = await db().query<{ invoice_number: string }>(
      `SELECT invoice_number FROM inbox_invoices WHERE thread_id = $1 AND invoice_number <> 'PENDING'`,
      [ev.thread_id]
    )
    const verified: PaidRow[] = []
    for (const ti of threadInvoices) verified.push(...(verifiedByInvoice.get(ti.invoice_number) ?? []))
    let received = verified.reduce((s, p) => s + p.amount, 0)

    const parts: string[] = []
    // Deposit the staff recorded (amount_paid) but no verified row yet: try
    // the bank feed now, record it if found.
    const knownDeposit = ev.amount_paid ?? 0
    if (knownDeposit > 0 && !verified.some((p) => Math.abs(p.amount - knownDeposit) < 0.01)) {
      const hit = findAmount(txns, knownDeposit, ev.customer_name)
      if (hit?.confirmed) {
        await recordVerified(
          ev.thread_id,
          ev.invoice_number,
          knownDeposit,
          `${hit.txn.contactName} ${fmtAud(knownDeposit)} on ${hit.txn.date.slice(0, 10)} (digest sweep)`
        )
        received += knownDeposit
        parts.push(`✅ deposit ${fmtAud(knownDeposit)} (${fmtDay(hit.txn.date)})`)
      } else {
        // Staff recorded it, the feed can't confirm it — still counts as
        // received for the balance math (staff-entered beats feed lag).
        received += knownDeposit
        parts.push(
          `☑️ deposit ${fmtAud(knownDeposit)} recorded by staff, not matched in feed` +
            (hit ? ` (possible: "${hit.txn.contactName}" ${fmtDay(hit.txn.date)})` : "")
        )
      }
    }
    for (const p of verified) {
      parts.push(`✅ ${fmtAud(p.amount)} received (${(p.matched_reference ?? "verified").split(" (")[0]})`)
    }
    const remaining = Math.max(0, Math.round((ev.amount - received) * 100) / 100)
    if (remaining > 0.005) {
      const hit = findAmount(txns, remaining, ev.customer_name)
      if (hit?.confirmed) {
        await recordVerified(
          ev.thread_id,
          ev.invoice_number,
          remaining,
          `${hit.txn.contactName} ${fmtAud(remaining)} on ${hit.txn.date.slice(0, 10)} (digest sweep)`
        )
        parts.push(`✅ balance ${fmtAud(remaining)} (${fmtDay(hit.txn.date)}) — PAID IN FULL 🎉`)
      } else {
        parts.push(
          `⏳ balance ${fmtAud(remaining)} outstanding` +
            (hit ? ` (possible match: "${hit.txn.contactName}" ${fmtAud(remaining)} ${fmtDay(hit.txn.date)} — confirm)` : "")
        )
      }
    } else if (parts.length) {
      parts.push("PAID IN FULL 🎉")
    }
    if (!parts.length) continue
    lines.push(
      `  • ${ev.customer_name ?? "?"} — ${fmtDay(ev.event_date)} — total ${fmtAud(ev.amount)}: ${parts.join(" · ")}`
    )
  }
  if (!lines.length) return ""
  return (
    `💰 Event payments (per Xero bank feed, reconciled to ${feedTo} — anything paid after that won't show until Louise reconciles):\n` +
    lines.join("\n")
  )
}
