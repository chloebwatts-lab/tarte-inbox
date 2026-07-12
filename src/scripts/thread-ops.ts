// One-off thread operations for staff-reported fixes, driven by CLI args so
// nothing customer-specific is committed (public repo). Commands:
//
//   label <threadId> <labelName>      apply a Gmail label to a thread
//   unread <threadId>                 mark a thread unread
//   rebuild-invoice <threadId>        build/rebuild invoice(s) from the thread
//   backfill-invoice-labels           Invoice created/sent labels onto all
//                                     recorded invoice threads
//
// Multiple commands can be chained with "--" separators.

import {
  processInvoiceRebuild,
  INVOICE_CREATED_LABEL,
  INVOICE_SENT_LABEL,
} from "../pipeline.js"
import { applyLabel, markThreadUnread, threadDraftReadState } from "../google/gmail.js"
import { db } from "../db/pool.js"
import { getThread as getThreadRow } from "../db/queries.js"

async function backfillInvoiceLabels(): Promise<void> {
  const { rows } = await db().query<{ thread_id: string | null; invoice_number: string }>(
    `SELECT DISTINCT thread_id, invoice_number FROM inbox_invoices
      WHERE invoice_number <> 'PENDING' AND thread_id IS NOT NULL AND thread_id <> ''`
  )
  for (const r of rows) {
    try {
      const row = await getThreadRow(r.thread_id!)
      // Sent by a human at some point → "sent"; otherwise still "created".
      const sent = row?.state === "sent_by_human" || row?.last_action === "captured_edit"
      // A thread that still has a pending draft is awaiting send regardless.
      const { hasDraft } = await threadDraftReadState(r.thread_id!)
      const label = sent && !hasDraft ? INVOICE_SENT_LABEL : INVOICE_CREATED_LABEL
      await applyLabel(r.thread_id!, label)
      console.log(`  ✓ ${r.invoice_number} -> ${label}`)
    } catch (e) {
      console.log(`  ! ${r.invoice_number}: ${e instanceof Error ? e.message : e}`)
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // split on "--"
  const groups: string[][] = [[]]
  for (const a of argv) {
    if (a === "--") groups.push([])
    else groups[groups.length - 1]!.push(a)
  }
  for (const g of groups.filter((x) => x.length)) {
    const [cmd, ...rest] = g
    try {
      if (cmd === "label") {
        await applyLabel(rest[0]!, rest.slice(1).join(" "))
        console.log(`✓ labeled ${rest[0]} with "${rest.slice(1).join(" ")}"`)
      } else if (cmd === "unread") {
        await markThreadUnread(rest[0]!)
        console.log(`✓ marked ${rest[0]} unread`)
      } else if (cmd === "rebuild-invoice") {
        const r = await processInvoiceRebuild(rest[0]!)
        console.log(`✓ rebuild-invoice ${rest[0]} -> ${r}`)
      } else if (cmd === "backfill-invoice-labels") {
        await backfillInvoiceLabels()
      } else {
        console.log(`? unknown command: ${cmd}`)
      }
    } catch (e) {
      console.error(`! ${cmd} failed:`, e instanceof Error ? e.message : e)
    }
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
