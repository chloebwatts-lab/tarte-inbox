import { anthropic, MODEL } from "./client.js"
import type { Playbook } from "../db/queries.js"
import type { Category } from "./classifier.js"

export interface DraftRequest {
  category: Category
  playbook: Playbook | null
  threadHistory: Array<{ from: string; date: Date; text: string }>
  customerName?: string
  customExtras?: Array<{ role: "user" | "assistant"; content: string }>
}

export interface DraftResult {
  body: string
  confidence: number
  flags: string[] // e.g. ['needs_floor_layout_check', 'mentions_deposit']
}

const SYSTEM_BASE = `You write email replies on behalf of Tarte, a hospitality business in Queensland, Australia. You write in the voice of Chloe (owner) — warm, professional, brisk, never gushing. Australian English.

Output STRICT JSON only:
{ "body": "<plain text reply, signed off with 'Tarte Team'>", "confidence": <0..1>, "flags": [<short strings>] }

Conventions:
- No greeting like "Dear Sir/Madam"; use first name if known, else "Hi there,"
- No marketing fluff. No "we appreciate your business."
- Don't quote prices unless the playbook gives them.
- If a question can't be answered without info you don't have, write a short holding reply and add "needs_human" to flags.
- Sign off "Tarte Team".
- For function enquiries that require floor-layout confirmation, write a holding reply and add "needs_floor_layout_check" to flags.

Flags to use when applicable: needs_human, needs_floor_layout_check, mentions_deposit, propose_slots, redirect_to_nbi.`

function renderPlaybook(p: Playbook | null): string {
  if (!p) return ""
  const exBlock = (p.examples ?? [])
    .slice(0, 3)
    .map(
      (ex, i) =>
        `--- example ${i + 1} ---\nIncoming:\n${ex.incoming}\nReply:\n${ex.reply}`
    )
    .join("\n\n")
  return [
    `\n--- playbook for category: ${p.category} ---`,
    `Description: ${p.description}`,
    `Voice guidance: ${p.voice_guidance}`,
    p.reply_template ? `Template:\n${p.reply_template}` : "",
    exBlock ? `Examples of past replies:\n${exBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function renderThread(
  history: DraftRequest["threadHistory"]
): string {
  return history
    .map((m) => {
      const when = m.date.toISOString().replace("T", " ").slice(0, 16)
      return `[${when}] From: ${m.from}\n${m.text}`
    })
    .join("\n\n---\n\n")
}

export async function draft(req: DraftRequest): Promise<DraftResult> {
  const system = SYSTEM_BASE + renderPlaybook(req.playbook)
  const user =
    `Reply to the latest message in this thread.` +
    (req.customerName ? ` Customer first name: ${req.customerName}.` : "") +
    `\n\nThread (oldest first):\n\n` +
    renderThread(req.threadHistory)
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      ...(req.customExtras ?? []),
      { role: "user", content: user },
    ],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") {
    return { body: "", confidence: 0, flags: ["needs_human", "no_output"] }
  }
  return parseJson(block.text)
}

function parseJson(text: string): DraftResult {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    return {
      body: "",
      confidence: 0,
      flags: ["needs_human", "unparseable"],
    }
  }
  try {
    const obj = JSON.parse(match[0]) as Partial<DraftResult>
    return {
      body: typeof obj.body === "string" ? obj.body : "",
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
      flags: Array.isArray(obj.flags) ? obj.flags.map(String) : [],
    }
  } catch {
    return { body: "", confidence: 0, flags: ["needs_human", "json_failed"] }
  }
}
