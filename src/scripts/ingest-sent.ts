// Pulls hello@'s past Sent messages, pairs each with the incoming message
// it replied to, classifies the incoming, and writes the top examples per
// category back into the playbooks table. Tunes the agent's voice without
// touching voice_guidance (that's a separate manual decision).
//
// Run on the droplet:
//   docker compose exec inbox node dist/scripts/ingest-sent.js --limit 200

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { classify, type Category } from "../llm/classifier.js"
import {
  getPlaybook,
  upsertPlaybook,
  listPlaybooks,
} from "../db/queries.js"
import { migrate } from "../db/pool.js"

const MAX_EXAMPLES_PER_CATEGORY = 3
const DEFAULT_LIMIT = 200

interface Pair {
  incomingFrom: string
  incomingSubject: string
  incomingBody: string
  replyBody: string
  date: Date
  threadId: string
}

function decodeBody(data: string | undefined | null): string {
  if (!data) return ""
  return Buffer.from(data, "base64url").toString("utf8")
}

function header(msg: any, name: string): string | undefined {
  return msg.payload?.headers?.find(
    (h: any) => h.name?.toLowerCase() === name.toLowerCase()
  )?.value
}

function extractText(payload: any): string {
  if (!payload) return ""
  let out = ""
  const walk = (p: any): void => {
    if (p.mimeType === "text/plain" && p.body?.data) {
      out += decodeBody(p.body.data)
    } else if (p.mimeType === "text/html" && p.body?.data && !out) {
      out += decodeBody(p.body.data)
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    }
    for (const sub of p.parts ?? []) walk(sub)
  }
  walk(payload)
  return out
}

/** Strip quoted reply blocks and signatures. Handles single-line, multi-line
 *  ("On 27 May 2026 at 06:10, Jenna Strauch / <strauch@...> / wrote:"),
 *  Outlook-style ("From: ... Sent: ..."), and Apple Mail variants. */
function dequote(body: string): string {
  const lines = body.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()
    // Single-line "On X wrote:"
    if (/^On .+wrote:?\s*$/i.test(trimmed)) break
    // Outlook chain headers
    if (/^From:\s/.test(trimmed) && i > 1) break
    if (/^-+\s*Original Message\s*-+/i.test(trimmed)) break
    // Quoted lines
    if (/^>\s?/.test(line)) continue
    // Signature delimiter
    if (/^--\s*$/.test(trimmed)) break
    out.push(line)
  }
  let text = out.join("\n").trim()
  // Final sweep: multi-line "On ...\n<email>\nwrote:" pattern that survives
  // because the first line doesn't end in "wrote:" itself.
  text = text
    .replace(/(^|\n)On\s[^\n]*(?:\n[^\n]*){0,4}wrote:?[\s\S]*$/i, "")
    // Apple Mail / iOS variant: "Sent from my iPhone" + chain below
    .replace(/\n+Sent from my (iPhone|iPad|Android|Outlook)[\s\S]*$/i, "")
    // Hanging "wrote:" or "> wrote:" alone on a final line
    .replace(/\n[>\s]*wrote:?\s*$/i, "")
  return text.trim()
}

async function fetchSentPairs(limit: number): Promise<Pair[]> {
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  // Pull sent messages
  const sentIds: string[] = []
  let pageToken: string | undefined
  while (sentIds.length < limit) {
    const r = await gmail.users.messages.list({
      userId: "me",
      q: "in:sent",
      maxResults: Math.min(100, limit - sentIds.length),
      pageToken,
    })
    for (const m of r.data.messages ?? []) {
      if (m.id) sentIds.push(m.id)
    }
    pageToken = r.data.nextPageToken ?? undefined
    if (!pageToken) break
  }

  console.log(`[ingest] found ${sentIds.length} sent messages`)
  const pairs: Pair[] = []
  const seenThreads = new Set<string>()

  for (const id of sentIds) {
    try {
      const r = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "full",
      })
      const msg = r.data
      const threadId = msg.threadId!
      if (seenThreads.has(threadId)) continue // one pair per thread max
      seenThreads.add(threadId)

      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full",
      })
      const msgs = thread.data.messages ?? []
      const sentIdx = msgs.findIndex((m: any) => m.id === id)
      if (sentIdx < 1) continue // no prior message to reply to

      const incoming = msgs[sentIdx - 1]
      if (!incoming) continue

      const incomingBody = dequote(extractText(incoming.payload))
      const replyBody = dequote(extractText(msg.payload))
      if (!incomingBody || !replyBody) continue
      if (incomingBody.length < 30 || replyBody.length < 30) continue

      pairs.push({
        incomingFrom: header(incoming, "from") ?? "",
        incomingSubject: header(incoming, "subject") ?? "",
        incomingBody: incomingBody.slice(0, 4000),
        replyBody: replyBody.slice(0, 2000),
        date: new Date(Number(msg.internalDate ?? Date.now())),
        threadId,
      })
    } catch (e) {
      console.warn(`[ingest] skip ${id}:`, e instanceof Error ? e.message : e)
    }
  }
  return pairs
}

async function classifyAll(pairs: Pair[]): Promise<Map<Category, Pair[]>> {
  const out = new Map<Category, Pair[]>()
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!
    process.stdout.write(`\r[ingest] classifying ${i + 1}/${pairs.length}`)
    try {
      const r = await classify(p.incomingSubject, p.incomingFrom, p.incomingBody)
      if (r.confidence < 0.7) continue
      const list = out.get(r.category) ?? []
      list.push(p)
      out.set(r.category, list)
    } catch (e) {
      // ignore, continue
    }
  }
  console.log()
  return out
}

function pickExamples(pairs: Pair[]): Array<{ incoming: string; reply: string }> {
  // Sort by recency desc, then pick the top N. Recency matters because tone
  // and pricing drift over time.
  return [...pairs]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, MAX_EXAMPLES_PER_CATEGORY)
    .map((p) => ({
      incoming: p.incomingBody.slice(0, 1500),
      reply: p.replyBody.slice(0, 1500),
    }))
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.split("=")[1]) : DEFAULT_LIMIT

  await migrate()

  const pairs = await fetchSentPairs(limit)
  console.log(`[ingest] usable pairs: ${pairs.length}`)
  if (!pairs.length) {
    console.log("[ingest] nothing to do")
    return
  }

  const grouped = await classifyAll(pairs)
  console.log("\n[ingest] examples per category:")
  for (const [cat, ps] of grouped) {
    console.log(`  ${cat}: ${ps.length} candidates`)
  }

  const playbooks = await listPlaybooks()
  for (const pb of playbooks) {
    const cat = pb.category as Category
    const candidates = grouped.get(cat)
    if (!candidates?.length) continue
    const examples = pickExamples(candidates)
    await upsertPlaybook({ ...pb, examples })
    console.log(`[ingest] updated ${cat} with ${examples.length} examples`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
