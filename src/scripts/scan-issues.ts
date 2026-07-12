// Read-only diagnostic for staff feedback batches. Reports:
//  1. State of named threads (customer names passed as CLI args — never
//     hardcoded here; the repo is public): labels, read state, drafts, replies.
//  2. All DB threads in state 'drafted' whose Gmail thread is currently READ.
//  3. Orphan drafts (standalone compose drafts with no real thread).
//  4. A sample Squarespace ORDER email (for the takeaway-high-tea parser).
//
// Usage: node dist/scripts/scan-issues.js "Name One" "Name Two" ...

import { google, type gmail_v1 } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { db } from "../db/pool.js"

function hdr(m: gmail_v1.Schema$Message | undefined, name: string): string {
  return (
    m?.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  )
}

async function main(): Promise<void> {
  const auth = await ensureGoogleAuthed()
  const g = google.gmail({ version: "v1", auth })

  // --- label id -> name map
  const labelRes = await g.users.labels.list({ userId: "me" })
  const labelName = new Map<string, string>()
  for (const l of labelRes.data.labels ?? []) if (l.id && l.name) labelName.set(l.id, l.name)

  const names = process.argv.slice(2)
  console.log("\n########## 1. NAMED THREADS ##########")
  for (const q of names) {
    const r = await g.users.threads.list({ userId: "me", q: `"${q}" newer_than:60d`, maxResults: 5 })
    console.log(`\n--- "${q}" → ${(r.data.threads ?? []).length} thread(s)`)
    for (const t of r.data.threads ?? []) {
      if (!t.id) continue
      const tg = await g.users.threads.get({ userId: "me", id: t.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] })
      const msgs = tg.data.messages ?? []
      const real = msgs.filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
      const drafts = msgs.length - real.length
      const last = real[real.length - 1]
      const unread = real.some((m) => (m.labelIds ?? []).includes("UNREAD"))
      const inInbox = real.some((m) => (m.labelIds ?? []).includes("INBOX"))
      const threadLabels = [...new Set(real.flatMap((m) => m.labelIds ?? []))]
        .map((id) => labelName.get(id) ?? id)
        .filter((n) => !/^(INBOX|UNREAD|IMPORTANT|SENT|CATEGORY_|Label_)/.test(n))
      const ourReplies = real.filter((m) => /tarte\.com\.au/i.test(hdr(m, "from"))).length
      const row = await db().query(
        `SELECT state, last_action, category FROM inbox_threads WHERE thread_id = $1`,
        [t.id]
      )
      const inv = await db().query(
        `SELECT invoice_number, kind FROM inbox_invoices WHERE thread_id = $1`,
        [t.id]
      )
      console.log(`  thread ${t.id}`)
      console.log(`    subject: ${hdr(real[0], "subject").slice(0, 70)}`)
      console.log(`    lastFrom: ${hdr(last, "from").slice(0, 60)}  msgs=${real.length} drafts=${drafts}`)
      console.log(`    unread=${unread ? "Y" : "N"} inbox=${inInbox ? "Y" : "N"} ourReplies=${ourReplies}`)
      console.log(`    labels: ${threadLabels.join(", ") || "(none)"}`)
      console.log(`    db: ${JSON.stringify(row.rows[0] ?? null)}  invoices: ${inv.rows.map((r2) => `${r2.invoice_number}(${r2.kind})`).join(",") || "none"}`)
    }
  }

  console.log("\n########## 2. DRAFTED-BUT-READ THREADS ##########")
  const drafted = await db().query<{ thread_id: string }>(
    `SELECT thread_id FROM inbox_threads WHERE state = 'drafted' ORDER BY last_processed_at DESC LIMIT 40`
  )
  let readCount = 0
  for (const r of drafted.rows) {
    try {
      const tg = await g.users.threads.get({ userId: "me", id: r.thread_id, format: "metadata", metadataHeaders: ["From", "Subject"] })
      const real = (tg.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
      const unread = real.some((m) => (m.labelIds ?? []).includes("UNREAD"))
      const hasDraft = (tg.data.messages ?? []).length > real.length
      if (!unread && hasDraft) {
        readCount++
        console.log(`  READ w/ pending draft: ${r.thread_id}  ${hdr(real[0], "subject").slice(0, 55)}`)
      }
    } catch {
      /* thread gone */
    }
  }
  console.log(`  → ${readCount} drafted thread(s) currently READ`)

  console.log("\n########## 3. ORPHAN DRAFTS ##########")
  const dl = await g.users.drafts.list({ userId: "me", maxResults: 100 })
  let orphans = 0
  for (const d of dl.data.drafts ?? []) {
    if (!d.id || !d.message?.threadId) continue
    const tg = await g.users.threads.get({ userId: "me", id: d.message.threadId, format: "metadata", metadataHeaders: ["To", "Subject"] })
    const real = (tg.data.messages ?? []).filter((m) => !(m.labelIds ?? []).includes("DRAFT"))
    if (real.length === 0) {
      orphans++
      const dm = tg.data.messages?.[0]
      console.log(`  orphan draft ${d.id}  to=${hdr(dm, "to").slice(0, 40)}  subj=${hdr(dm, "subject").slice(0, 45)}`)
    }
  }
  console.log(`  → ${orphans} orphan draft(s)`)

  console.log("\n########## 4. SQUARESPACE ORDER SAMPLE ##########")
  const sq = await g.users.threads.list({ userId: "me", q: `from:squarespace order newer_than:60d`, maxResults: 5 })
  for (const t of sq.data.threads ?? []) {
    if (!t.id) continue
    const tg = await g.users.threads.get({ userId: "me", id: t.id, format: "full" })
    const m = tg.data.messages?.[0]
    console.log(`  from: ${hdr(m, "from")}`)
    console.log(`  subject: ${hdr(m, "subject")}`)
    // print first 800 chars of the text body
    const walk = (p: gmail_v1.Schema$MessagePart | undefined): string => {
      if (!p) return ""
      if (p.mimeType === "text/plain" && p.body?.data)
        return Buffer.from(p.body.data, "base64url").toString("utf8")
      for (const part of p.parts ?? []) {
        const got = walk(part)
        if (got) return got
      }
      return ""
    }
    console.log(`  body: ${walk(m?.payload ?? undefined).slice(0, 800).replace(/\n{2,}/g, "\n")}`)
    break
  }
  console.log("")
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
