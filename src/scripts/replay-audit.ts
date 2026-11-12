// Re-drafts past emails with the CURRENT drafter and prints the result next to
// what the old agent wrote and what the team actually sent. Read-only: nothing
// is saved, drafted in Gmail, or sent.
//   node dist/scripts/replay-audit.js <learning id> [<learning id> ...]

import { db } from "../db/pool.js"
import { getThread } from "../google/gmail.js"
import { getPlaybook } from "../db/queries.js"
import { draft } from "../llm/drafter.js"
import { dequote } from "../lib/dequote.js"
import { config } from "../config.js"
import type { Category } from "../llm/classifier.js"

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).map(Number).filter(Boolean)
  const hello = config().HELLO_MAILBOX.toLowerCase()
  for (const id of ids) {
    const r = await db().query(
      "select thread_id, category, our_draft, sent_reply from inbox_learnings where id = $1",
      [id]
    )
    const row = r.rows[0]
    if (!row) continue
    const thread = await getThread(row.thread_id)
    // Cut the thread back to the moment before the team's reply.
    const needle = norm(row.sent_reply).slice(0, 60)
    let cut = thread.messages.findIndex(
      (m) => m.from.toLowerCase().includes(hello) && norm(dequote(m.bodyText)).includes(needle)
    )
    if (cut < 0) cut = thread.messages.length
    const msgs = thread.messages.slice(0, cut)
    const last = [...msgs].reverse().find((m) => !m.from.toLowerCase().includes(hello))
    const first = last?.from.match(/^"?([A-Za-z][A-Za-z'-]*)/)?.[1]
    const d = await draft({
      category: row.category as Category,
      playbook: await getPlaybook(row.category),
      threadHistory: msgs.map((m) => ({
        from: m.from,
        date: m.date,
        text: dequote(m.bodyText).slice(0, 16000),
      })),
      customerName: first,
    })
    console.log(`\n################ learning ${id} (${row.category}), ${msgs.length} msgs before reply`)
    console.log(`--- CUSTOMER ASKED ---\n${dequote(last?.bodyText ?? "").slice(0, 700)}`)
    console.log(`--- OLD DRAFT ---\n${row.our_draft.slice(0, 900)}`)
    console.log(`--- TEAM SENT ---\n${row.sent_reply.slice(0, 900)}`)
    console.log(`--- NEW DRAFT (flags: ${d.flags.join(", ") || "none"}) ---\n${d.body}`)
  }
  await db().end()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
