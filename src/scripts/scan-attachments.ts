// Surveys hello@'s past Sent messages for attachments, classifies the
// incoming message of each thread, and reports which attachment filenames
// are commonly used per category. Read-only — doesn't change anything.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/scan-attachments.js --limit=300

import { google, type gmail_v1 } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { classify, type Category } from "../llm/classifier.js"

const DEFAULT_LIMIT = 300

interface Hit {
  threadId: string
  date: Date
  category: Category | null
  filenames: string[]
}

function decode(data: string | undefined | null): string {
  if (!data) return ""
  return Buffer.from(data, "base64url").toString("utf8")
}

function header(msg: gmail_v1.Schema$Message | gmail_v1.Schema$MessagePart, name: string): string | undefined {
  return (msg as gmail_v1.Schema$Message).payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  )?.value ?? undefined
}

function collectAttachments(payload: gmail_v1.Schema$MessagePart | undefined): string[] {
  if (!payload) return []
  const out: string[] = []
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.filename && p.filename.length > 0) {
      // Skip inline images that aren't real attachments
      const dispo = p.headers?.find((h) => h.name?.toLowerCase() === "content-disposition")?.value
      const isAttachment = !dispo || /attachment/i.test(dispo)
      if (isAttachment) out.push(p.filename)
    }
    for (const sub of p.parts ?? []) walk(sub)
  }
  walk(payload)
  return out
}

function extractText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ""
  let out = ""
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.mimeType === "text/plain" && p.body?.data) out += decode(p.body.data)
    else if (p.mimeType === "text/html" && p.body?.data && !out) {
      out += decode(p.body.data)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    }
    for (const sub of p.parts ?? []) walk(sub)
  }
  walk(payload)
  return out
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.split("=")[1]) : DEFAULT_LIMIT

  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  // Pull sent messages with attachments (q: has:attachment in:sent)
  const ids: string[] = []
  let pageToken: string | undefined
  while (ids.length < limit) {
    const r = await gmail.users.messages.list({
      userId: "me",
      q: "in:sent has:attachment",
      maxResults: Math.min(100, limit - ids.length),
      pageToken,
    })
    for (const m of r.data.messages ?? []) {
      if (m.id) ids.push(m.id)
    }
    pageToken = r.data.nextPageToken ?? undefined
    if (!pageToken) break
  }

  console.log(`[scan] found ${ids.length} sent messages with attachments`)
  const hits: Hit[] = []
  const seenThreads = new Set<string>()

  for (const id of ids) {
    try {
      const r = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      })
      const msg = r.data
      const threadId = msg.threadId!
      if (seenThreads.has(threadId)) continue
      seenThreads.add(threadId)

      const filenames = collectAttachments(msg.payload ?? undefined)
      if (!filenames.length) continue

      // Get the thread to find the incoming message we were replying to
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full",
      })
      const msgs = thread.data.messages ?? []
      const sentIdx = msgs.findIndex((m) => m.id === id)
      const incoming = sentIdx > 0 ? msgs[sentIdx - 1] : undefined

      let category: Category | null = null
      if (incoming) {
        const subj = header(incoming, "subject") ?? ""
        const from = header(incoming, "from") ?? ""
        const body = extractText(incoming.payload ?? undefined).slice(0, 4000)
        if (body.length > 30) {
          const c = await classify(subj, from, body)
          if (c.confidence >= 0.7) category = c.category
        }
      }

      hits.push({
        threadId,
        date: new Date(Number(msg.internalDate ?? Date.now())),
        category,
        filenames,
      })
    } catch (e) {
      console.warn(`[scan] skip ${id}:`, e instanceof Error ? e.message : e)
    }
  }

  // Aggregate
  const byCategory = new Map<string, Map<string, number>>()
  for (const h of hits) {
    const key = h.category ?? "(unclassified)"
    const tally = byCategory.get(key) ?? new Map<string, number>()
    for (const f of h.filenames) {
      // Normalise: strip dates, version numbers, leading numbers
      const norm = f
        .replace(/\s+\d{1,2}[._\- /]\d{1,2}[._\- /]\d{2,4}/g, "")
        .replace(/[\s_]+v?\d+(\.\d+)?/g, "")
        .replace(/\s+/g, " ")
        .trim()
      tally.set(norm, (tally.get(norm) ?? 0) + 1)
    }
    byCategory.set(key, tally)
  }

  console.log("\n=== Attachments per category ===")
  for (const [cat, tally] of byCategory) {
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])
    console.log(`\n${cat} (${hits.filter((h) => (h.category ?? "(unclassified)") === cat).length} threads)`)
    for (const [name, count] of sorted.slice(0, 10)) {
      console.log(`  ${count}x  ${name}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
