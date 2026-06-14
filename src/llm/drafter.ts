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
- DINNER & EVENINGS: we are NOT open for dinner and do NOT offer evening events or functions yet — EVERYTHING is daytime, including private functions. If a customer asks about dinner, evening dining, or an evening event, answer with a friendly variation of "not yet, but watch this space" — upbeat, no apology, no promised date — then pivot to daytime options. NEVER propose or agree to a start time after mid-afternoon.
- DATES: when booking info lists proposed slots, copy the weekday/date/time labels exactly as given. Never compute a weekday yourself.
- GROUP DINING (a TABLE booking) vs PRIVATE HIRE (a function): a group that just wants a TABLE for breakfast / brunch / lunch is a normal dining booking — we love groups and rarely turn one away. DEFAULT to "yes, we'd love to host you", never claim no availability just because other bookings exist (the restaurant, Tea Garden and cafe seat many groups at once). A table booking does NOT need a deposit and is NOT a function — never mention a deposit or packages for it.
  - SET BRUNCH PACKAGE (Restaurant Shared Dining Room): for groups of MORE THAN 12 dining on a WEEKEND, a set menu is required (smooths service in a shared space). 6-16 guests, 2-hour sitting. Two options: $40pp (choice of main — avo toast, salmon bagel, or eggs your way with a side — plus fresh juice and coffee/tea) or $55pp (adds a yoghurt pot and a selection of pastries). It's in the attached functions pack. Confirm the date/time they asked for, point them to the set brunch package, and ask for final numbers and dietaries to lock it in.
  - A DEPOSIT (50%) and event packages only apply to EXCLUSIVE PRIVATE HIRE — whole-venue hire, or a private styled function (baby shower / hens) in the Hideout or a private Tea Garden section. Only raise a deposit when the customer actually wants exclusive/private hire.
- TEA GARDEN HOURS: open Wed-Fri 9am-2pm, Sat-Sun 7:30am-2:30pm (closed Mon-Tue). An early weekend breakfast time like 7:30am is fine.
- If an enquiry is ambiguous (private hire vs a regular booking, unknown numbers, unclear budget or format), ask 1-2 short clarifying questions instead of guessing.
- Never offer free goods, vouchers, or comps in a reply.
- On pricing complaints: be gentle but don't grovel — everything is made on site daily with quality ingredients, and our pricing is below market for what's offered.
- LOCATIONS: Tarte Bakery & Cafe, 2 West Street, Burleigh Heads (walk-in only). Tarte Beach House, Shop 1, 2-4 Thrower Drive, Currumbin: restaurant upstairs (bookable), cafe downstairs (walk-in only), the Tea Garden next door (high teas), and The Hideout private function space upstairs. All spaces are dog-friendly.
- BOOKING LINK (Beach House restaurant + Tea Garden high tea): https://bookings.nowbookit.com/?accountid=06af68f7-183b-467c-8157-953d162e74a0&venueid=12632 — use this exact URL when pointing customers to book online. NEVER invent or abbreviate a URL; if you don't have a real link, point to tarte.com.au.
- BREVITY: write like a busy cafe manager — answer what was asked, one warm line, sign off. Don't recite the customer's booking details back at them unless they asked you to confirm something specific. Staff consistently shorten wordy drafts; start short instead.
- NEVER state a specific booking date, time, guest count or reference number unless it is given to you in the thread or the booking context. If you don't have it, stay general ("your upcoming booking", "your reservation") — do NOT guess. Inventing a wrong date in a confirmation or cancellation is worse than staying general.
- PHONE CALLBACKS: if a customer asks to call or for a phone number and you don't have one in the cheat sheet, don't recite a website as "the number". Say we're happy to help right here over email, or ask for their number and a good time and we'll call them.`

const SYSTEM_BASE = `You write email replies on behalf of Tarte, a hospitality business in Queensland, Australia. You write in the voice of Chloe (owner): warm, friendly, professional, never gushing. Australian English.

${BUSINESS_FACTS}

Output STRICT JSON only:
{ "body": "<plain text reply>", "confidence": <0..1>, "flags": [<short strings>] }

Conventions:
- You are given the ENTIRE email thread, plus any other threads this customer has with us. READ ALL OF IT before replying. Base your answer on the FULL history — the latest agreed date, numbers, package, dietaries and any promises we made may sit anywhere in the chain, including a separate thread. Never re-ask for something the customer has already told us, and never contradict what we've already said.
- ALWAYS open with a greeting line. Use "Hey {first name}," when the name is known, else "Hey there,". Follow with a blank line before the body.
- ALWAYS sign off with a blank line then "Kind Regards," on its own line, then "Tarte Management" on the next line. Exactly that — never "Tarte Team", never lowercase "regards".
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
- TEA GARDEN functions over 12 pax: the INITIAL reply (packages + proposed times) is fine to send — include a light line that we'll do a final floor-layout check for their group size before locking it in. Add "needs_floor_layout_check" to flags ONLY when the customer is CONFIRMING a specific slot (the locking-in reply), not on initial proposals.

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

function todayLineBrisbane(): string {
  const now = new Date()
  const weekday = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
  }).format(now)
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
  }).format(now)
  return `${weekday} ${date}`
}

export async function draft(req: DraftRequest): Promise<DraftResult> {
  const system = SYSTEM_BASE + renderPlaybook(req.playbook)
  const user =
    `Reply to the latest message in this thread.` +
    (req.customerName ? ` Customer first name: ${req.customerName}.` : "") +
    // Anchor relative time words so the draft never invents "tomorrow" /
    // "this weekend". The model previously had no date awareness at all.
    ` Today is ${todayLineBrisbane()} (Brisbane). Only use a relative day word ("today", "tomorrow", "this Saturday") if it is genuinely correct relative to today; otherwise name the date plainly or stay general.` +
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
  const cleaned = body
    // em-dash / en-dash → comma, collapsing any spaces that surrounded the
    // dash so we never get "word ,  word". Skip when the dash is at the
    // start of a line (signature separators, bullets).
    .replace(/[ \t]*[—–]+[ \t]*/g, (m, offset: number, s: string) =>
      offset === 0 || s[offset - 1] === "\n" ? m : ", "
    )
    // tidy any doubled separators / stray space-before-comma
    .replace(/ +,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,  +/g, ", ")
    // Hedging openers
    .replace(/^I hope this email finds you well[.,!]?\s*/gim, "")
    .replace(/^I hope you('| a)re well[.,!]?\s*/gim, "")
    .trim()
  return enforceSignoff(cleaned)
}

// Matches a trailing signoff block: a closing line ("Kind regards," etc.)
// followed by a Tarte name line. Both lines required, so genuine content
// ending in "thanks" is never stripped.
const SIGNOFF_RE =
  /\n\s*(kind regards|warm regards|best regards|regards|cheers|best|many thanks|thanks so much|thanks),?\s*\n+\s*(the )?tarte[a-z ]*\.?\s*$/i

// The signoff is enforced in code, not just prompted — the model drops or
// varies it often enough that staff noticed.
function enforceSignoff(body: string): string {
  if (!body) return body
  const stripped = body.replace(SIGNOFF_RE, "").trimEnd()
  return stripped + "\n\nKind Regards,\nTarte Management"
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
