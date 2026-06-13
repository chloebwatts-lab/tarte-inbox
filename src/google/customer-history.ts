// Cross-thread customer context. Given a sender's email, fetch their OTHER
// threads with hello@ and read them IN FULL so the agent has 100% of what this
// customer has ever discussed — even when they start a brand-new chain. This
// is what lets us give true answers ("you already booked the 9th", "you told
// us 30 guests") instead of asking again.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "./oauth.js"
import { renderFullThread } from "../lib/thread-text.js"

const MAX_OTHER_THREADS = 6
const PER_THREAD_CHARS = 6000 // full dequoted content of each other thread
const TOTAL_CONTEXT_CHARS = 24000

function decodeBody(data: string | undefined | null): string {
  if (!data) return ""
  return Buffer.from(data, "base64url").toString("utf8")
}

function header(payload: any, name: string): string | undefined {
  return payload?.headers?.find(
    (h: any) => h.name?.toLowerCase() === name.toLowerCase()
  )?.value
}

function extractText(payload: any): string {
  if (!payload) return ""
  let text = ""
  let html = ""
  const walk = (p: any): void => {
    if (p.mimeType === "text/plain" && p.body?.data) text += decodeBody(p.body.data)
    else if (p.mimeType === "text/html" && p.body?.data) html += decodeBody(p.body.data)
    for (const sub of p.parts ?? []) walk(sub)
  }
  walk(payload)
  return text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

export interface CustomerHistoryEntry {
  threadId: string
  date: Date
  subject: string
  /** Full dequoted conversation content of the other thread. */
  content: string
  hasOutbound: boolean
}

/**
 * Returns up to MAX_OTHER_THREADS recent threads involving the sender,
 * EXCLUDING the current thread, each read IN FULL (every message, dequoted).
 */
export async function fetchCustomerHistory(
  senderEmail: string,
  excludeThreadId: string
): Promise<CustomerHistoryEntry[]> {
  const email = senderEmail.trim().toLowerCase()
  if (!email) return []
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  const r = await gmail.users.threads.list({
    userId: "me",
    q: `(from:${email} OR to:${email}) newer_than:365d`,
    maxResults: MAX_OTHER_THREADS + 5,
  })
  const ids = (r.data.threads ?? [])
    .map((t) => t.id)
    .filter((id): id is string => !!id && id !== excludeThreadId)
    .slice(0, MAX_OTHER_THREADS + 3)

  const out: CustomerHistoryEntry[] = []
  for (const id of ids) {
    if (out.length >= MAX_OTHER_THREADS) break
    try {
      // format=full so we read the actual conversation, not just a snippet.
      const t = await gmail.users.threads.get({ userId: "me", id, format: "full" })
      const messages = t.data.messages ?? []
      if (!messages.length) continue
      const first = messages[0]!
      const dateMs = first.internalDate ? Number(first.internalDate) : Date.now()
      const subject = header(first.payload, "Subject") ?? "(no subject)"
      const msgLikes = messages.map((m) => ({
        from: header(m.payload, "From") ?? "",
        date: new Date(m.internalDate ? Number(m.internalDate) : Date.now()),
        bodyText: extractText(m.payload),
      }))
      const content = renderFullThread(msgLikes).slice(0, PER_THREAD_CHARS)
      const hasOutbound = msgLikes.some((m) =>
        m.from.toLowerCase().includes("@tarte.com.au")
      )
      out.push({ threadId: id, date: new Date(dateMs), subject, content, hasOutbound })
    } catch {
      // ignore
    }
  }
  return out
}

/** Render full cross-thread history for the drafter prompt. Empty if none. */
export function renderCustomerHistory(history: CustomerHistoryEntry[]): string {
  if (!history.length) return ""
  let block = ""
  for (const h of history.sort((a, b) => b.date.getTime() - a.date.getTime())) {
    const when = h.date.toISOString().slice(0, 10)
    const entry =
      `\n=== Other thread [${when}] "${h.subject}" (${h.hasOutbound ? "we replied" : "no reply yet"}) ===\n${h.content}\n`
    if (block.length + entry.length > TOTAL_CONTEXT_CHARS) break
    block += entry
  }
  return (
    `\n--- THIS CUSTOMER'S OTHER THREADS WITH US (read in full) ---` +
    block +
    `\nUse everything above as known context — including from these separate chains — so you give true, consistent answers and never re-ask for details the customer already gave us. Don't quote these threads back at them unless relevant.\n`
  )
}
