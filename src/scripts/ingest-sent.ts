// Pulls hello@'s past Sent messages, pairs each with the incoming message
// it replied to, classifies the incoming, and writes the top examples per
// category back into the playbooks table. Tunes the agent's voice without
// touching voice_guidance (that's a separate manual decision).
//
// NOT side-effect free: a normal run REPLACES the `examples` on every playbook
// that has candidates, and the drafter uses those examples on the next tick.
// Since go-live most Sent replies started life as an agent draft, so a fresh
// ingest largely feeds the agent its own wording back. Use --dry-run first and
// get Chloe's OK before a real run.
//
// Run on the droplet:
//   docker compose exec -T inbox node dist/scripts/ingest-sent.js --limit=500 --dry-run
//
// --dry-run reads Gmail, classifies and reports counts. It writes nothing.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { classify, type Category } from "../llm/classifier.js"
import { listPlaybooks } from "../db/queries.js"
import { db, migrate } from "../db/pool.js"

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

import { dequote } from "../lib/dequote.js"

function parseEmailAddr(value: string | undefined): string {
  if (!value) return ""
  const m = value.match(/<([^>]+)>/)
  return (m ? m[1] : value)!.trim().toLowerCase()
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
  let droppedNotToCustomer = 0
  let droppedInternal = 0

  // Tarte-internal addresses we don't want to learn examples from (chats
  // between staff are not "customer replies").
  const INTERNAL_DOMAINS = ["tarte.com.au"]
  const INTERNAL_ADDRESSES = new Set<string>([
    "louise@accountantgc.com.au", // bookkeeper — adjust as we learn more
  ])

  for (const id of sentIds) {
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

      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full",
      })
      const msgs = thread.data.messages ?? []
      const sentIdx = msgs.findIndex((m: any) => m.id === id)
      if (sentIdx < 1) continue

      const incoming = msgs[sentIdx - 1]
      if (!incoming) continue

      // Reject internal-only threads and forwards (the bug Chris flagged:
      // "Can you please invoice / Bianca Zorn..." was a Chloe→bookkeeper
      // message paired with the customer's enquiry as if it were the reply).
      const incomingFromAddr = parseEmailAddr(header(incoming, "from"))
      const replyToAddrs = (header(msg, "to") ?? "")
        .split(",")
        .map((s) => parseEmailAddr(s))
        .filter(Boolean)
      const replyCcAddrs = (header(msg, "cc") ?? "")
        .split(",")
        .map((s) => parseEmailAddr(s))
        .filter(Boolean)
      const allRecipients = [...replyToAddrs, ...replyCcAddrs]

      // 1. The reply must actually go back to the incoming sender (or at
      //    least include them on the To/Cc list). Otherwise it's a forward.
      if (incomingFromAddr && !allRecipients.includes(incomingFromAddr)) {
        droppedNotToCustomer++
        continue
      }

      // 2. Skip threads where the "customer" is actually internal (staff
      //    chatting, or messages to the bookkeeper).
      const isInternal = (addr: string): boolean =>
        INTERNAL_ADDRESSES.has(addr) ||
        INTERNAL_DOMAINS.some((d) => addr.endsWith("@" + d))
      if (isInternal(incomingFromAddr)) {
        droppedInternal++
        continue
      }

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
  if (droppedNotToCustomer || droppedInternal) {
    console.log(
      `[ingest] dropped: ${droppedNotToCustomer} forwards (reply didn't go to sender), ${droppedInternal} internal threads`
    )
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
  // Accept both --limit=500 and --limit 500 (the header used to show the
  // second form, which was silently ignored).
  const args = process.argv.slice(2)
  const limitEq = args.find((a) => a.startsWith("--limit="))
  const limitIdx = args.indexOf("--limit")
  const limitRaw = limitEq ? limitEq.split("=")[1] : limitIdx >= 0 ? args[limitIdx + 1] : undefined
  const limit = Number(limitRaw) > 0 ? Number(limitRaw) : DEFAULT_LIMIT
  const dryRun = args.includes("--dry-run")
  console.log(`[ingest] limit=${limit}${dryRun ? " (dry run, nothing will be written)" : ""}`)

  if (!dryRun) await migrate()

  const pairs = await fetchSentPairs(limit)
  console.log(`[ingest] usable pairs: ${pairs.length}`)
  if (!pairs.length) {
    console.log("[ingest] nothing to do")
    return
  }

  // How many of these replies began as one of OUR drafts? (edit-capture writes
  // an inbox_learnings row for every drafted thread a human then sent.)
  const { rows: learned } = await db().query<{ thread_id: string }>(
    `SELECT DISTINCT thread_id FROM inbox_learnings WHERE thread_id = ANY($1::text[])`,
    [pairs.map((p) => p.threadId)]
  )
  const agentDrafted = new Set(learned.map((r) => r.thread_id))
  console.log(
    `[ingest] ${pairs.filter((p) => agentDrafted.has(p.threadId)).length} of ${pairs.length} usable pairs are replies that started as an agent draft`
  )

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
    if (dryRun) {
      const picked = [...candidates]
        .sort((a, b) => b.date.getTime() - a.date.getTime())
        .slice(0, MAX_EXAMPLES_PER_CATEGORY)
      console.log(
        `[ingest] would replace ${pb.examples?.length ?? 0} example(s) on ${cat} with ${examples.length} ` +
          `(${picked.filter((p) => agentDrafted.has(p.threadId)).length} of them agent-drafted replies)`
      )
      continue
    }
    // Touch ONLY the examples column. A whole-row upsert from this snapshot
    // could undo a FAQ edit staff saved in the TK admin page mid-run.
    await db().query(
      `UPDATE inbox_playbooks SET examples = $2::jsonb, updated_at = now() WHERE category = $1`,
      [cat, JSON.stringify(examples)]
    )
    console.log(`[ingest] updated ${cat} with ${examples.length} examples`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
