// Cross-thread customer context. Given a sender's email, fetch their other
// recent threads with hello@ so the drafter can see what's already been
// discussed (e.g. yesterday's deposit thread, last week's enquiry).
//
// Capped to keep prompt size sane: last N threads, last 90 days,
// short snippets only.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "./oauth.js"

const MAX_OTHER_THREADS = 5
const SNIPPET_MAX = 280

export interface CustomerHistoryEntry {
  threadId: string
  date: Date
  subject: string
  snippet: string
  // True when our team replied to this thread (so the drafter knows there's
  // history of an outbound response).
  hasOutbound: boolean
}

function parseEmailAddr(value: string | undefined): string {
  if (!value) return ""
  const m = value.match(/<([^>]+)>/)
  return (m ? m[1] : value)!.trim().toLowerCase()
}

function header(payload: any, name: string): string | undefined {
  return payload?.headers?.find(
    (h: any) => h.name?.toLowerCase() === name.toLowerCase()
  )?.value
}

/**
 * Returns up to MAX_OTHER_THREADS recent threads involving the given sender,
 * EXCLUDING the thread we're currently processing.
 */
export async function fetchCustomerHistory(
  senderEmail: string,
  excludeThreadId: string
): Promise<CustomerHistoryEntry[]> {
  const email = senderEmail.trim().toLowerCase()
  if (!email) return []
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  // Pull recent threads from this sender. Use both "from:" and a broader
  // "<email>" search to catch threads where they were CC'd / replied to one of ours.
  const r = await gmail.users.threads.list({
    userId: "me",
    q: `(from:${email} OR to:${email}) newer_than:90d`,
    maxResults: MAX_OTHER_THREADS + 5, // pull a few extras in case we exclude
  })
  const ids = (r.data.threads ?? [])
    .map((t) => t.id)
    .filter((id): id is string => !!id && id !== excludeThreadId)
    .slice(0, MAX_OTHER_THREADS + 3)

  const out: CustomerHistoryEntry[] = []
  for (const id of ids) {
    if (out.length >= MAX_OTHER_THREADS) break
    try {
      const t = await gmail.users.threads.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      })
      const messages = t.data.messages ?? []
      if (!messages.length) continue
      const first = messages[0]!
      const dateMs = first.internalDate ? Number(first.internalDate) : Date.now()
      const subject = header(first.payload, "Subject") ?? "(no subject)"
      const snippet =
        (t.data.messages?.[messages.length - 1]?.snippet ?? "").slice(0, SNIPPET_MAX) ||
        (first.snippet ?? "").slice(0, SNIPPET_MAX)
      // Detect outbound: any message from us in the thread
      const hasOutbound = messages.some((m) => {
        const from = parseEmailAddr(header(m.payload, "From"))
        return from.endsWith("@tarte.com.au")
      })
      out.push({
        threadId: id,
        date: new Date(dateMs),
        subject,
        snippet,
        hasOutbound,
      })
    } catch {
      // ignore
    }
  }
  return out
}

/** Render history for inclusion in the drafter prompt. Empty string if none. */
export function renderCustomerHistory(history: CustomerHistoryEntry[]): string {
  if (!history.length) return ""
  const lines = history
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map((h) => {
      const when = h.date.toISOString().slice(0, 10)
      const tag = h.hasOutbound ? "we replied" : "no reply yet"
      return `  [${when}] (${tag}) ${h.subject}\n     → ${h.snippet}`
    })
    .join("\n")
  return (
    `\n--- Other recent threads from this customer (last 90 days) ---\n` +
    `${lines}\n` +
    `Use this to avoid asking for info we already have or repeating what we already said. ` +
    `Don't reference these threads directly unless relevant — they're context only.\n`
  )
}
