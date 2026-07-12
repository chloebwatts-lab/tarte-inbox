// Backfill: apply the Tea Garden label to EXISTING threads that mention tea
// garden / high tea but don't carry either TG label yet. The live overlay in
// the pipeline only covers mail processed after it shipped — this sweeps the
// backlog. Skips our own outbound-only threads (digests etc.) and pure
// automated senders. Dry-run by default; --apply acts.

import { google, type gmail_v1 } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"

const TG_LABELS = ["Events / Tea Garden - High Tea", "Events / Tea Garden - Functions"]
const TG_RE = /\btea ?garden\b|\bhigh ?tea\b/i
// Don't label pure system noise (NBI daily summaries mention high teas daily)
// or marketing/cold senders that merely mention high tea.
const SKIP_FROM =
  /nowbookit\.com|no-?reply@|mailer|postmaster|squarespace\.com|highteasociety|hospitality suppliers expo|@send\./i

function hdr(m: gmail_v1.Schema$Message | undefined, name: string): string {
  return m?.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const auth = await ensureGoogleAuthed()
  const g = google.gmail({ version: "v1", auth })

  const labelRes = await g.users.labels.list({ userId: "me" })
  const byName = new Map((labelRes.data.labels ?? []).map((l) => [l.name ?? "", l.id ?? ""]))
  const tgIds = TG_LABELS.map((n) => byName.get(n)).filter(Boolean) as string[]
  const highTeaId = byName.get(TG_LABELS[0]!)
  if (!highTeaId) throw new Error("TG label not found")

  const r = await g.users.threads.list({
    userId: "me",
    q: `("tea garden" OR "high tea") newer_than:90d`,
    maxResults: 150,
  })
  let labelled = 0
  for (const t of r.data.threads ?? []) {
    if (!t.id) continue
    const tg = await g.users.threads.get({
      userId: "me",
      id: t.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject"],
    })
    const msgs = (tg.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    if (!msgs.length) continue
    const allIds = new Set(msgs.flatMap((m) => m.labelIds ?? []))
    if (tgIds.some((id) => allIds.has(id))) continue // already labelled
    const first = msgs[0]
    const subject = hdr(first, "subject")
    // Every message from us (digests, reports) or from automated senders → skip.
    const senders = msgs.map((m) => hdr(m, "from"))
    const allOurs = senders.every((f) => /hello@tarte\.com\.au/i.test(f))
    const firstExternal = senders.find((f) => !/tarte\.com\.au/i.test(f)) ?? ""
    if (allOurs || SKIP_FROM.test(firstExternal)) continue
    // Confirm the match is in the subject or snippet (cheap textual check).
    const text = subject + " " + msgs.map((m) => m.snippet ?? "").join(" ")
    if (!TG_RE.test(text)) continue
    if (apply) {
      await g.users.threads.modify({
        userId: "me",
        id: t.id,
        requestBody: { addLabelIds: [highTeaId] },
      })
      console.log(`  ✓ labelled: ${subject.slice(0, 60) || "(no subject)"}`)
    } else {
      console.log(`  • would label: ${subject.slice(0, 60) || "(no subject)"}  (${firstExternal.slice(0, 40)})`)
    }
    labelled++
  }
  console.log(`\n${apply ? `Labelled ${labelled}.` : `Would label ${labelled}.  Re-run with --apply.`}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
