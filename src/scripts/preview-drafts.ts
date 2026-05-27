// Generates fresh drafts (in-memory only, doesn't save) for the most recent
// customer-driven threads where the agent would draft a reply. Useful for
// previewing how the live drafter sounds with current settings + playbooks.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/preview-drafts.js --limit=5

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { classify, CATEGORY_LABELS, type Category } from "../llm/classifier.js"
import { draft } from "../llm/drafter.js"
import { getPlaybook } from "../db/queries.js"
import { fetchCustomerHistory, renderCustomerHistory } from "../google/customer-history.js"
import { config } from "../config.js"

const DEFAULT_LIMIT = 5

const SKIP_CATEGORIES = new Set<Category>([
  "marketing_cold_outreach",
  "needs_human",
  "accounts_invoices",
])

function decode(data: string | undefined | null): string {
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

function parseEmailAddr(value: string | undefined): string {
  if (!value) return ""
  const m = value.match(/<([^>]+)>/)
  return (m ? m[1] : value)!.trim().toLowerCase()
}

function firstName(from: string): string | undefined {
  const nameMatch = from.match(/^([^<]+)</)
  if (!nameMatch) return undefined
  const name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "")
  const first = name.split(/\s+/)[0]
  return first && /^[A-Za-z][A-Za-z'-]*$/.test(first) ? first : undefined
}

async function main(): Promise<void> {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.split("=")[1]) : DEFAULT_LIMIT

  const helloMail = config().HELLO_MAILBOX.toLowerCase()
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  // Pull recent inbox threads — same query the live scheduler uses
  const list = await gmail.users.threads.list({
    userId: "me",
    q: "in:inbox -category:promotions newer_than:14d",
    maxResults: 40,
  })
  const ids = (list.data.threads ?? [])
    .map((t) => t.id!)
    .filter(Boolean)

  let shown = 0
  for (const id of ids) {
    if (shown >= limit) break
    const t = await gmail.users.threads.get({
      userId: "me",
      id,
      format: "full",
    })
    const messages = t.data.messages ?? []
    const latest = messages[messages.length - 1]
    if (!latest) continue
    const from = header(latest, "From") ?? ""
    if (from.toLowerCase().includes(helloMail)) continue // skip outbound-latest
    // skip handed-off threads
    const hasShawna = messages.some((m) => {
      const to = (header(m, "To") ?? "").toLowerCase()
      const cc = (header(m, "Cc") ?? "").toLowerCase()
      return to.includes("shawna@tarte.com.au") || cc.includes("shawna@tarte.com.au")
    })
    if (hasShawna) continue

    const body = extractText(latest.payload).slice(0, 6000)
    if (body.length < 30) continue

    const c = await classify(header(latest, "Subject") ?? "", from, body)
    if (SKIP_CATEGORIES.has(c.category)) continue

    const playbook = await getPlaybook(c.category)
    const senderAddr = parseEmailAddr(from)
    const history = senderAddr
      ? await fetchCustomerHistory(senderAddr, id)
      : []
    const historyBlock = renderCustomerHistory(history)

    const d = await draft({
      category: c.category,
      playbook,
      threadHistory: messages.map((m) => ({
        from: header(m, "From") ?? "",
        date: new Date(Number(m.internalDate ?? Date.now())),
        text: extractText(m.payload).slice(0, 3000),
      })),
      customerName: firstName(from),
      customExtras: historyBlock
        ? [{ role: "user", content: historyBlock }]
        : undefined,
    })

    shown++
    console.log("\n" + "═".repeat(80))
    console.log(`THREAD ${shown}: ${CATEGORY_LABELS[c.category]}`)
    console.log(`From: ${from}`)
    console.log(`Subject: ${header(latest, "Subject")}`)
    console.log(`Classifier: confidence ${c.confidence.toFixed(2)} — ${c.rationale}`)
    if (history.length) {
      console.log(`Cross-thread context: ${history.length} other recent thread(s) from this customer`)
    }
    console.log("─".repeat(80))
    console.log("INCOMING (customer wrote):")
    console.log(body.slice(0, 600) + (body.length > 600 ? "\n  […]" : ""))
    console.log("─".repeat(80))
    console.log(`DRAFT (confidence ${d.confidence.toFixed(2)}${d.flags.length ? ", flags: " + d.flags.join("/") : ""}):`)
    console.log(d.body)
  }

  console.log("\n" + "═".repeat(80))
  console.log(`Shown ${shown} preview drafts.`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
