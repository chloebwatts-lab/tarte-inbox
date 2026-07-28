// Backfill / verify Xero event drafts for booked-in FUTURE events.
// Uses the exact production sync path (guards, upsert, notifications), so a
// second run doubles as the idempotency test: every row should come back
// with the SAME Xero invoice id and no duplicates.
//
//   Run on the droplet (needs prod DB + Xero tokens; tsx is dev-only so use
//   the compiled build):
//     docker compose exec inbox node dist/scripts/backfill-event-drafts.js [--limit N]
import { db } from "../db/pool.js"
import {
  lineItemsFromExtraction,
  syncXeroEventDraft,
  type InvoiceExtraction,
} from "../invoice/from-thread.js"

interface Row {
  invoice_number: string
  thread_id: string
  editable: unknown
  xero_invoice_id: string | null
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf("--limit")
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 50
  // Latest invoice per thread only (revisions share the thread), future events only.
  const { rows } = await db().query<Row>(
    `SELECT DISTINCT ON (thread_id)
            invoice_number, thread_id, editable, xero_invoice_id
       FROM inbox_invoices
      WHERE thread_id <> '' AND editable IS NOT NULL
        AND (editable->>'event_date') IS NOT NULL
        AND (editable->>'event_date')::date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
      ORDER BY thread_id, id DESC
      LIMIT $1`,
    [limit]
  )
  console.log(`[backfill] ${rows.length} future-event invoice(s) to sync`)
  for (const r of rows) {
    const x = r.editable as InvoiceExtraction
    try {
      const lines = lineItemsFromExtraction(x)
      const before = r.xero_invoice_id ?? "(none)"
      await syncXeroEventDraft(r.invoice_number, r.thread_id, x, lines)
      const after = await db().query<{ xero_invoice_id: string | null }>(
        `SELECT xero_invoice_id FROM inbox_invoices WHERE invoice_number = $1`,
        [r.invoice_number]
      )
      console.log(
        `[backfill] ${r.invoice_number} ${x.customer_name ?? x.customer_email ?? "?"} event ${x.event_date}: ` +
          `${before} -> ${after.rows[0]?.xero_invoice_id ?? "(none)"}`
      )
    } catch (e) {
      console.error(`[backfill] ${r.invoice_number} FAILED:`, e instanceof Error ? e.message : e)
    }
  }
  process.exit(0)
}
void main()
