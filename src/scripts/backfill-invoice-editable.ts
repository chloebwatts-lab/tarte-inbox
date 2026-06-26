// One-off backfill: invoices created before the `editable` column existed have
// no stored booking detail, so the quick-amend form can't regenerate them.
// This re-reads each such invoice's thread, extracts the agreed detail, and
// stores it as `editable` — purely additive (only fills NULLs), never changes
// an invoice number or amount, never sends anything.

import { migrate, db } from "../db/pool.js"
import { getThread } from "../google/gmail.js"
import { extractInvoiceDetails } from "../invoice/from-thread.js"

function todayBrisbane(): { date: string; weekday: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
  }).format(new Date())
  return { date, weekday }
}

async function main(): Promise<void> {
  await migrate()
  const { date, weekday } = todayBrisbane()
  const { rows } = await db().query<{ id: number; invoice_number: string; thread_id: string | null }>(
    `SELECT id, invoice_number, thread_id FROM inbox_invoices
      WHERE editable IS NULL AND thread_id IS NOT NULL AND invoice_number <> 'PENDING'
      ORDER BY id`
  )
  console.log(`[backfill] ${rows.length} invoice(s) missing editable detail`)
  let filled = 0
  for (const r of rows) {
    try {
      const thread = await getThread(r.thread_id!)
      if (!thread.messages.length) {
        console.log(`  - ${r.invoice_number}: thread empty, skipped`)
        continue
      }
      const x = await extractInvoiceDetails(thread, date, weekday)
      if (!x || (x.guests == null && x.per_person_price == null)) {
        console.log(`  - ${r.invoice_number}: could not extract usable detail, skipped`)
        continue
      }
      await db().query(`UPDATE inbox_invoices SET editable = $1 WHERE id = $2 AND editable IS NULL`, [
        JSON.stringify(x),
        r.id,
      ])
      filled++
      console.log(
        `  ✓ ${r.invoice_number}: ${x.customer_name ?? "?"} — ${x.guests ?? "?"} guests @ $${x.per_person_price ?? "?"}`
      )
    } catch (e) {
      console.error(`  ! ${r.invoice_number}: ${e instanceof Error ? e.message : e}`)
    }
  }
  console.log(`[backfill] done — filled ${filled}/${rows.length}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
