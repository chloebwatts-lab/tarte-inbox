// Prints per-message from/date/labels for a thread, next to the stored
// draftedAt — for debugging why edit-capture didn't match a sent reply.
//   docker compose exec inbox node dist/scripts/debug-thread.js <threadId>

import { getThread } from "../google/gmail.js"
import { db } from "../db/pool.js"

async function main(): Promise<void> {
  const threadId = process.argv[2]
  if (!threadId) throw new Error("usage: debug-thread.js <threadId>")
  const row = await db().query(
    `SELECT meta->>'draftedAt' AS drafted_at, state, last_action FROM inbox_threads WHERE thread_id = $1`,
    [threadId]
  )
  console.log("db row:", row.rows[0])
  const t = await getThread(threadId)
  for (const m of t.messages) {
    console.log({
      from: m.from,
      date: m.date.toISOString(),
      labels: m.labelIds.join(","),
    })
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
