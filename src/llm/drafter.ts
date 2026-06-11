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

// Facts that apply across every category. Playbook FAQ entries can add to
// these but must not contradict them.
const BUSINESS_FACTS = `Business facts (always true, any category):
- Tarte sells CRULLERS, not churros. Never write "churro".
- DINNER: we are NOT open for dinner yet. If a customer asks about dinner, evening dining, or dinner bookings, answer with a friendly variation of "not yet, but watch this space" — upbeat, no apology, no promised date. Then redirect to what we DO offer (daytime dining, high tea, functions) if it fits naturally.
- Never offer free goods, vouchers, or comps in a reply.
- On pricing complaints: be gentle but don't grovel — everything is made on site daily with quality ingredients, and our pricing is below market for what's offered.`

const SYSTEM_BASE = `You write email replies on behalf of Tarte, a hospitality business in Queensland, Australia. You write in the voice of Chloe (owner): warm, friendly, professional, never gushing. Australian English.

${BUSINESS_FACTS}

Output STRICT JSON only:
{ "body": "<plain text reply>", "confidence": <0..1>, "flags": [<short strings>] }

Conventions:
- ALWAYS open with a greeting line. Use "Hey {first name}," when the name is known, else "Hey there,". Follow with a blank line before the body.
- ALWAYS sign off with a blank line then "Kind regards," on its own line, then "Tarte Team" on the next line.
- Warm but brisk. No marketing fluff, no "we appreciate your business".
- Do NOT use em-dashes (—) or en-dashes (–). They are the most common AI tell. Use a comma, a regular hyphen with spaces (e.g. " - "), a full stop, or a new sentence instead.
- Avoid other AI tells: "I hope this email finds you well", "delve into", "in essence", "navigate this together", "rest assured". Just say the thing.
- CONFIDENCE: You ARE a member of the Tarte team. You know the business. NEVER sound unknowledgeable, uncertain, or like you're "checking" on something — that makes Tarte look unprofessional. Phrases like "I can't confirm right now", "I'm just checking on that", "I'll have to get back to you" are FORBIDDEN for any topic. If you don't have the exact detail, give the customer the next-best useful answer (a link, a general statement, what's true 90% of the time) rather than admitting you don't know.
  - If the answer is in the playbook cheat sheet below, quote it directly.
  - If the answer involves prices and they're not in the cheat sheet, point the customer at where prices are shown (the booking page link for high teas/dine-in, the attached functions pack for functions).
  - If the answer is genuinely unknown to you AND there's no useful place to point them, write the body without trying to answer that part, add "needs_human" to flags, and the human reviewing the draft will fill in the answer. Don't pretend to be "just checking on that" — that's a stall.
  - For things like gift vouchers, opening hours, our address, our phone, where to park: if the playbook doesn't have it, just say something like "Best place to find that is on our website tarte.com.au" rather than pretending to chase up the answer.
- CRITICAL — NEVER ask the customer to re-specify information they've already given in the thread. Specifically:
  - If they named one or more dates (e.g. "last weekend in July", "the 15th", "anytime in October"), treat those dates as given. Do NOT say "if you can send through your preferred date".
  - If they named a pax count, treat it as given.
  - If they named a package or event type (high tea, baby shower, etc.), treat it as given.
  - If "Booking flow info" below includes proposed slots, propose THOSE specific dates and times. Do not ask the customer to pick a date again.
- If a question can't be answered without info you don't have AND that info is genuinely not in the thread, write a short holding reply and add "needs_human" to flags.
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
  // FAQ entries with non-empty answers are authoritative facts. Empty answers
  // are intentionally hidden — they're for human review only, not the agent.
  const faqEntries = (p.faq ?? []).filter(
    (f) => f.question?.trim() && f.answer?.trim()
  )
  const faqBlock = faqEntries.length
    ? "Cheat sheet (authoritative facts — quote these directly when relevant):\n" +
      faqEntries.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
    : ""
  return [
    `\n--- playbook for category: ${p.category} ---`,
    `Description: ${p.description}`,
    `Voice guidance: ${p.voice_guidance}`,
    p.reply_template ? `Template:\n${p.reply_template}` : "",
    faqBlock,
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

// Post-process to strip AI tells the model snuck through despite the prompt.
function debot(body: string): string {
  return (
    body
      // em-dash / en-dash → comma + space
      .replace(/[—–]/g, ", ")
      // double "  " from the replacement above
      .replace(/, , /g, ", ")
      // Hedging openers
      .replace(/^I hope this email finds you well[.,!]?\s*/gim, "")
      .replace(/^I hope you('| a)re well[.,!]?\s*/gim, "")
      .trim()
  )
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
      body: typeof obj.body === "string" ? debot(obj.body) : "",
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
      flags: Array.isArray(obj.flags) ? obj.flags.map(String) : [],
    }
  } catch {
    return { body: "", confidence: 0, flags: ["needs_human", "json_failed"] }
  }
}
