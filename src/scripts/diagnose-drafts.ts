// Read-only: inspects current drafts in hello@ and reports, per draft, whether
// it threads off the LAST message in its conversation (correct ordering) or an
// earlier one (the "out of order" bug), plus the thread's read state and
// whether it carries an invoice. Helps confirm the threading fix.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"

const SINCE = Date.parse(process.argv[2] ?? "2026-06-24")

function hdr(headers: { name?: string | null; value?: string | null }[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
}

async function main(): Promise<void> {
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })
  const list = await gmail.users.drafts.list({ userId: "me", maxResults: 100 })
  const drafts = list.data.drafts ?? []
  console.log(`\n=== ${drafts.length} drafts; showing those since ${new Date(SINCE).toISOString().slice(0, 10)} ===\n`)

  for (const d of drafts) {
    if (!d.id) continue
    const dg = await gmail.users.drafts.get({ userId: "me", id: d.id, format: "metadata" })
    const dm = dg.data.message
    const threadId = dm?.threadId
    const dDate = dm?.internalDate ? Number(dm.internalDate) : 0
    if (!threadId || dDate < SINCE) continue
    const draftInReplyTo = hdr(dm?.payload?.headers ?? undefined, "in-reply-to")

    const t = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: ["Message-ID", "From", "Subject"] })
    const msgs = (t.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    const last = msgs[msgs.length - 1]
    const lastMsgId = hdr(last?.payload?.headers ?? undefined, "message-id")
    const subject = hdr(msgs[0]?.payload?.headers ?? undefined, "subject")
    const unread = msgs.some((m) => (m.labelIds ?? []).includes("UNREAD"))

    // Which message does the draft reply to?
    let idx = -1
    msgs.forEach((m, i) => {
      if (hdr(m.payload?.headers ?? undefined, "message-id") === draftInReplyTo) idx = i
    })
    const inOrder = draftInReplyTo && draftInReplyTo === lastMsgId
    const pos = idx === -1 ? "unknown msg" : `msg ${idx + 1}/${msgs.length}`

    console.log(
      `${inOrder ? "✓ in-order " : "✗ OUT-OF-ORDER"}  ${subject.slice(0, 45).padEnd(45)}  replies to ${pos}  unread=${unread ? "Y" : "N"}`
    )
  }
  console.log("")
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
