// Recovery: brings recently auto-archived REAL-person emails from nowbookit.com
// back into the inbox (they were wrongly treated as automated). Leaves genuine
// automated NBI notifications/summaries archived. Additive only (adds INBOX +
// UNREAD); never deletes. Dry-run by default; --apply to restore.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { isAutomatedNowBookIt } from "../pipeline.js"

function hdr(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })
  const list = await gmail.users.threads.list({
    userId: "me",
    q: "from:nowbookit.com newer_than:21d -in:inbox",
    maxResults: 50,
  })
  const threads = list.data.threads ?? []
  console.log(`\n=== ${apply ? "RESTORING" : "DRY RUN"} — ${threads.length} archived nowbookit thread(s) in last 21d ===\n`)
  let restored = 0
  for (const t of threads) {
    if (!t.id) continue
    const tg = await gmail.users.threads.get({ userId: "me", id: t.id, format: "metadata", metadataHeaders: ["Subject", "From"] })
    const msgs = (tg.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    const last = msgs[msgs.length - 1]
    const subject = hdr(last?.payload?.headers ?? undefined, "subject")
    const from = hdr(last?.payload?.headers ?? undefined, "from")
    if (isAutomatedNowBookIt(from, subject)) {
      console.log(`  – leave (automated): ${subject.slice(0, 55)}`)
      continue
    }
    if (apply) {
      await gmail.users.threads.modify({ userId: "me", id: t.id, requestBody: { addLabelIds: ["INBOX", "UNREAD"] } })
      console.log(`  ✓ restored: ${from.slice(0, 35)} — ${subject.slice(0, 50)}`)
    } else {
      console.log(`  • would restore: ${from.slice(0, 35)} — ${subject.slice(0, 50)}`)
    }
    restored++
  }
  console.log(`\n${apply ? `Restored ${restored}.` : `Would restore ${restored}.  Re-run with --apply.`}\n`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
