// Deletes ORPHAN drafts — standalone compose drafts whose thread contains no
// real (sent/received) message. These are leftovers from earlier systems
// (e.g. "[Tarte Triage]" reports) and superseded standalone form replies.
// In-thread reply drafts are never touched. Dry-run by default; --apply acts.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const auth = await ensureGoogleAuthed()
  const g = google.gmail({ version: "v1", auth })
  const dl = await g.users.drafts.list({ userId: "me", maxResults: 200 })
  let deleted = 0
  for (const d of dl.data.drafts ?? []) {
    if (!d.id || !d.message?.threadId) continue
    const tg = await g.users.threads.get({
      userId: "me",
      id: d.message.threadId,
      format: "metadata",
      metadataHeaders: ["To", "Subject"],
    })
    const real = (tg.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    if (real.length > 0) continue // reply draft inside a real thread — keep
    const dm = tg.data.messages?.[0]
    const hdr = (n: string): string =>
      dm?.payload?.headers?.find((h) => h.name?.toLowerCase() === n)?.value ?? ""
    // Only clear automation junk and stale superseded drafts. Recipient-less
    // drafts with a subject are almost certainly the girls' SAVED TEMPLATES
    // ("High Tea Info", "Tarte Opening Hours") — never touch those; nor any
    // fresh compose someone might still be writing.
    const subject = hdr("subject")
    const to = hdr("to")
    const ageDays = dm?.internalDate ? (Date.now() - Number(dm.internalDate)) / 86400_000 : 0
    const isAutomationJunk =
      /^\[tarte triage\]/i.test(subject) || /^we.?ve received your enquiry$/i.test(subject)
    const isStaleSuperseded = Boolean(to) && ageDays > 21
    if (!isAutomationJunk && !isStaleSuperseded) continue
    if (apply) {
      try {
        await g.users.drafts.delete({ userId: "me", id: d.id })
        deleted++
        console.log(`  ✓ deleted: ${hdr("subject").slice(0, 60) || "(no subject)"}  to=${hdr("to").slice(0, 40)}`)
      } catch (e) {
        console.log(`  ! failed: ${d.id} — ${e instanceof Error ? e.message : e}`)
      }
    } else {
      deleted++
      console.log(`  • would delete: ${hdr("subject").slice(0, 60) || "(no subject)"}  to=${hdr("to").slice(0, 40)}`)
    }
  }
  console.log(`\n${apply ? `Deleted ${deleted}.` : `Would delete ${deleted}.  Re-run with --apply.`}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
