// One-time backlog sweep: archive threads the agent already classified as
// noise (noreply receipts, confident cold outreach) but left sitting in the
// inbox from before archiving existed. Idempotent — archiving an archived
// thread is a no-op, and nothing is deleted.

import { archiveThread } from "../google/gmail.js"
import { db } from "../db/pool.js"

async function main(): Promise<void> {
  const { rows } = await db().query<{ thread_id: string; state: string }>(
    `SELECT thread_id, state FROM inbox_threads
      WHERE state = 'noreply_skipped'
         OR (category = 'marketing_cold_outreach' AND state = 'classified' AND confidence >= 0.75)`
  )
  console.log(`${rows.length} noise thread(s) to archive`)
  let ok = 0
  for (const r of rows) {
    try {
      await archiveThread(r.thread_id)
      ok++
    } catch (e) {
      console.warn(
        `skip ${r.thread_id}:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  console.log(`archived ${ok}/${rows.length}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
