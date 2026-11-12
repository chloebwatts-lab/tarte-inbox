import { anthropic, MODEL } from "./client.js"
import { listActiveHouseNotes, type Playbook } from "../db/queries.js"
import type { Category } from "./classifier.js"
import { PACKAGES_BLOCK, amountsIn } from "./packages.js"
import { extractBooking } from "./booking.js"
import { availabilityBlock, claimsAvailability, datesToCheck } from "../availability.js"

export interface DraftRequest {
  category: Category
  playbook: Playbook | null
  threadHistory: Array<{ from: string; date: Date; text: string }>
  customerName?: string
  customExtras?: Array<{ role: "user" | "assistant"; content: string }>
  /** Dates (YYYY-MM-DD) to check against the function calendar. When omitted,
   * booking-type categories work them out from the thread themselves, so
   * EVERY draft path gets the check, not just new function enquiries. */
  calendarDates?: string[]
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
  - RESTAURANT SET MENUS: tables of 12 to 16 in the restaurant need a set menu Friday to Sunday (prices and rules in PACKAGES BY SPACE, section 1). They are for the RESTAURANT. Do not offer them to a Tea Garden or Hideout enquiry unless section 4 applies. Name the two options with their prices in one line each and point to the attached functions pack for what is included. Do NOT type out the dishes. If the customer has not given a date, time or numbers yet, ask for those first and leave the menus for the next email.
  - A DEPOSIT (50%) and event packages only apply to EXCLUSIVE PRIVATE HIRE — whole-venue hire, or a private styled function (baby shower / hens) in the Hideout or a private Tea Garden section. Only raise a deposit when the customer actually wants exclusive/private hire.
- LARGE GROUPS (30-60+): NEVER make it sound difficult or say we have no options. Be warm and can-do. Recommend TEA GARDEN WHOLE-VENUE HIRE and point them to the attached functions pack. If they ask what it costs, the hire fee and the per person package are BOTH payable (PACKAGES BY SPACE, section 3).
- OFFER ALTERNATIVES: don't steer a customer to a single option. Where it fits, also mention a relevant alternative (e.g. a group brunch enquiry — also offer high tea) and let them choose. Don't sway to one decision unless it's genuinely the only fit.
- AMBIGUOUS / MISSING YEAR: if a date is given without a year (e.g. "Saturday 5th", "in August"), ASK which year up front before quoting availability — don't assume, or your availability answer will be wrong.
- PAST DATES: if the date they gave has already passed, assume it's a slip (likely a later month). Gently flag it and ASK them to confirm the date, rather than assuming a month and telling them it's unavailable.
- AVAILABILITY: you cannot see the booking system. Never tell a customer a date or time is available, open or free, and never say a NEW booking has been made (a teammate does that). Only say a space is taken when a "Calendar check" below tells you so. Otherwise offer to check availability and get it booked in.
- GROUPS OVER 12 CANNOT BOOK ONLINE: the website only takes bookings of up to 12 guests, in the restaurant and the Tea Garden. Never send a group of 13 or more to the website to book. Ask for whatever is missing (date, time, numbers) and say we will check availability and book it in for them.
- SEATING REQUESTS (outdoor, verandah, window, a particular table or view): say we will note the preference but specific tables cannot be guaranteed. Never promise one, and never describe how busy or quiet a day will be.
- CHRISTMAS: we are CLOSED on Christmas Day, every venue. We are open on all other public holidays (a surcharge applies). If asked about Christmas Day, say so simply and offer another day; nothing else.
- AMENITIES / EQUIPMENT / SERVICES: NEVER claim we have, provide, or DON'T have a physical item (tablecloths, linen, cake stands, easels, speakers, high chairs) or that we do or don't offer a service, unless the cheat sheet or the thread says so explicitly. Guessing has burned us in BOTH directions (a draft invented tablecloths we don't provide; another denied the takeaway high tea we DO offer). If it's not in your facts, write the reply without that claim and add "needs_human" so a teammate fills in the real answer.
- DIETARIES: keep it BRIEF. Something like "Yes, we're flexible and happy to accommodate dietaries as best we can - just let us know closer to the day." Never write a long over-explained dietary paragraph.
- BOTTOMLESS MIMOSAS: YES, we offer them. A bottomless mimosa add-on is $39 per person for 75 minutes (available from 10am) on Tea Garden high teas. If anyone asks about bottomless drinks / bottomless brunch / mimosas, confirm we have this — never say we don't.
- KIDS HIGH TEA: YES, we offer a kids high tea at $35 per child. It's a child-friendly version of our high tea with a smaller selection of sandwiches, pastries and sweets, suited to kids up to around 12. Babies and very young toddlers who don't need their own food, drink or place setting join free of charge. Takeaway/catering-style versions are also available. If anyone asks whether a kids option or kids price exists, confirm it — never say you're unsure or need to check. If they're adding kids to an existing booking, ask how many and say we'll note it on the booking.
- UNKNOWN GUEST NUMBERS: if a function/event enquiry hasn't given guest numbers, do NOT narrow them to a single venue or package. Briefly note we have options for all group sizes, point them to the attached functions pack, and ASK how many guests they're expecting so you can recommend the right fit. Recommend a specific venue/package only once you know the size.
- WARMTH OVER BLUNTNESS: brief does NOT mean blunt. Stay warm and welcoming. Never sound presumptuous or negative — don't tell a customer they'll be "waiting around", "chancing it", or that something is "difficult". Frame everything helpfully and positively.
- CAKES: outside cakes are NOT permitted at our venues, full stop — no exceptions, no cakeage arrangement, never tell a customer they can bring their own cake. We make celebration cakes IN-HOUSE but do NOT do fully custom cakes (no custom designs, no custom wedding cakes) — customers order our Tarte Signature Celebration Cake, a professional buttercream cake, directly on the website: https://tarte.com.au/order/p/tarte-signature-celebration-cake (light vanilla sponge with dulce de leche or raspberries & cream filling, finished with fresh berries or naked; 6-inch tiered, 6+8-inch or 8-inch, from $155; minimum 3 days' notice, contact us for approval if sooner; pickup from Burleigh or Currumbin, no delivery). When the cake is for a booking with us, send that order link and say we'll note the cake on their booking and have it ready at the table on the day. Don't punt cake questions to "the team" — this IS the answer.
- The Tea Garden is open Wed-Sun (closed Mon-Tue); an early weekend breakfast time like 7:30am is fine. (See the HOURS line above for the full opening times.)
- GENERAL BOOKING / HIGH-TEA ENQUIRIES (someone asking "do you do high teas / can I book a table / what are your hours"): keep it simple — thank them, give the booking link (tarte.com.au/beachhouse) so they can view live availability and book instantly, and include the relevant info (Tea Garden hours above, the walk-in cafe, Tea Garden closed Mon-Tue, Burleigh walk-in only). Do NOT go check the calendar and propose specific dates/times for a general enquiry — let them book online. Only get into specific date-checking for a true FUNCTION (private hire / large group).
- If an enquiry is ambiguous (private hire vs a regular booking, unknown numbers, unclear budget or format), ask 1-2 short clarifying questions instead of guessing.
- Never offer free goods, vouchers, or comps in a reply.
- On pricing complaints: be gentle but don't grovel — everything is made on site daily with quality ingredients, and our pricing is below market for what's offered.
- LOCATIONS: Tarte Bakery & Cafe, 2 West Street, Burleigh Heads (WALK-IN ONLY, no bookings). Tarte Beach House, Shop 1, 2-4 Thrower Drive, Currumbin: the Cafe on the sand (walk-in only), the Restaurant (bookable), the Tea Garden next door (high teas), and The Hideout, our upstairs private function room attached to the Restaurant (not an independent venue; views of the creek and the 100-year-old fig tree). The Hideout is the ONLY upstairs space — never describe the Cafe, Restaurant or Tea Garden as "upstairs" or "downstairs". All spaces are dog-friendly.
- HOURS: The Tea Garden / High Tea at Currumbin is open Wed-Fri 9am-2pm and Sat-Sun 7:30am-2:30pm, CLOSED Monday & Tuesday. The Currumbin cafe downstairs and Burleigh Heads are walk-in only. For Beach House restaurant booking times, point customers to our website (tarte.com.au/beachhouse) which shows live availability — do NOT quote specific restaurant opening hours.
- BOOKING LINK: always send customers to our WEBSITE, https://tarte.com.au/beachhouse (the "Reserve" button there opens our booking system). NEVER paste a raw nowbookit.com link — use the tarte.com.au website page. If unsure, just say "you can book via our website, tarte.com.au".
- BREVITY: write like a busy cafe manager — answer what was asked, one warm line, sign off. Don't recite the customer's booking details back at them unless they asked you to confirm something specific. Staff consistently shorten wordy drafts; start short instead.
- FUNCTION ENQUIRIES — KEEP IT SHORT (5 sentences max): warmly say we'd love to host them, name the ONE format that fits (e.g. "whole-venue hire" or "a private section") in a few words, and REFER them to the attached functions pack for packages and pricing. Do NOT write out venue-hire fees, package prices, menus, bond or deposit amounts in a FIRST reply — the pack has all of that; listing them makes the email far too long. Ask for the ONE most important missing detail (date, numbers or which option), not a list of questions. When the customer asks a direct price question, answer it exactly from PACKAGES BY SPACE in one or two lines. Close function replies the way the team does: "Let me know which option you are most interested in and I would be more than happy to check availability and get something booked in for you."
- HOLDING DEPOSIT / PRE-AUTH: when we secure a booking with a card, make clear it's a PRE-AUTHORISATION — just a temporary hold to secure the date, NO payment is actually taken. Reassure them on this whenever a card-on-file/holding deposit is mentioned. (A deposit INVOICE for a confirmed function is different — that's an actual payment; don't confuse the two.)
- NEVER state a specific booking date, time, guest count or reference number unless it is given to you in the thread or the booking context. If you don't have it, stay general ("your upcoming booking", "your reservation") — do NOT guess. Inventing a wrong date in a confirmation or cancellation is worse than staying general.
- PHONE CALLBACKS: if a customer asks to call or for a phone number and you don't have one in the cheat sheet, don't recite a website as "the number". Say we're happy to help right here over email, or ask for their number and a good time and we'll call them.`

const SYSTEM_BASE = `You write email replies on behalf of Tarte, a hospitality business in Queensland, Australia. You write in the voice of Chloe (owner): warm, friendly, professional, never gushing. Australian English.

${BUSINESS_FACTS}

${PACKAGES_BLOCK}

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
- If a question can't be answered without info you don't have AND that info is genuinely not in the thread, write a short holding reply and add "needs_human" to flags.
- TEA GARDEN functions over 12 pax: add "needs_floor_layout_check" to flags ONLY when the customer is CONFIRMING a specific slot (the locking-in reply), not on initial proposals.

- These rules beat the playbook below. If a playbook template or voice note tells you to list available windows, propose slots, or say a time is free, ignore that part.

Flags to use when applicable: needs_human, needs_floor_layout_check, mentions_deposit, redirect_to_nbi.`

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

// Staff-written live guidance from the TK admin (inbox_house_notes). Layered
// UNDER the hard rules: anything in SYSTEM_BASE / BUSINESS_FACTS wins on
// conflict, and the code-level guards (sign-off, debot) run regardless.
// Never sourced from customer email content — staff input only.
function renderHouseNotes(notes: Array<{ body: string; author: string }>): string {
  if (!notes.length) return ""
  const lines = notes
    .map((n) => `- ${n.body.slice(0, 500).replace(/\s+/g, " ").trim()} [${n.author}]`)
    .join("\n")
  return (
    `\n--- house notes from Tarte staff (live guidance) ---\n` +
    `Apply these when drafting. They may add facts, phrasing or tone preferences. ` +
    `If a note conflicts with any rule above (the sign-off, no em-dashes/AI tells, ` +
    `no comps or vouchers, crullers not churros, no dinner yet), the rule above wins.\n` +
    lines
  )
}

async function loadHouseNotesBlock(): Promise<string> {
  try {
    return renderHouseNotes(await listActiveHouseNotes())
  } catch (e) {
    // A notes hiccup must never block drafting.
    console.error("[drafter] house notes unavailable:", e instanceof Error ? e.message : e)
    return ""
  }
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

// Categories where a customer may be asking about a date. Each of these gets
// the calendar check, whichever code path asked for the draft.
const CALENDAR_CATEGORIES = new Set<string>([
  "events_beach_house_functions",
  "events_tea_garden_functions",
  "events_tea_garden_high_tea",
  "bookings_dine_in",
  "bookings_existing",
  "general_enquiries",
])
const DATEISH_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b|\b\d{1,2}(st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\b(tomorrow|next week|this weekend|new year|easter)\b/i

async function calendarDatesFor(req: DraftRequest): Promise<string[]> {
  if (req.calendarDates) return req.calendarDates
  if (!CALENDAR_CATEGORIES.has(req.category)) return []
  const text = renderThread(req.threadHistory)
  if (!DATEISH_RE.test(text)) return []
  try {
    return datesToCheck(await extractBooking(text))
  } catch (e) {
    console.error("[drafter] date extraction failed:", e instanceof Error ? e.message : e)
    return []
  }
}

/** Display names of everyone on the thread who is not us, so calendar entries
 * carrying the customer's own name are recognised as theirs. */
function customerNamesFrom(req: DraftRequest): string[] {
  const names = new Set<string>()
  for (const m of req.threadHistory) {
    if (/@tarte\.com\.au/i.test(m.from)) continue
    const display = m.from.match(/^\s*"?([^"<@]+?)"?\s*</)?.[1]?.trim()
    if (display) names.add(display)
  }
  if (req.customerName && ![...names].some((n) => n.toLowerCase().startsWith(req.customerName!.toLowerCase())))
    names.add(req.customerName)
  return [...names]
}

/** Deterministic checks on a finished draft. The prompt asks; this verifies.
 * Anything caught is flagged for the teammate reviewing the draft. */
export function guardDraft(
  result: DraftResult,
  ctx: { knownText: string; calendarBlock: string }
): DraftResult {
  if (!result.body) return result
  const flags = new Set(result.flags)
  const known = amountsIn(ctx.knownText)
  const unknown = [...amountsIn(result.body)].filter((a) => !known.has(a))
  if (unknown.length) {
    flags.add("unverified_price")
    flags.add("needs_human")
  }
  const hideoutTaken = /Hideout is NOT available this day/.test(ctx.calendarBlock)
  const teaGardenSetMenu =
    /tea garden/i.test(result.body) && /set (brunch|lunch|menu)|family[- ]style lunch/i.test(result.body)
  if (!hideoutTaken && (/\$79\b/.test(result.body) || teaGardenSetMenu)) {
    flags.add("check_package_matches_space")
    flags.add("needs_human")
  }
  if (claimsAvailability(result.body)) {
    flags.add("check_calendar_before_sending")
    flags.add("needs_human")
  }
  return { ...result, flags: [...flags] }
}

export async function draft(req: DraftRequest): Promise<DraftResult> {
  const system = SYSTEM_BASE + (await loadHouseNotesBlock()) + renderPlaybook(req.playbook)
  const calDates = await calendarDatesFor(req)
  const calendarBlock = calDates.length
    ? await availabilityBlock(calDates, customerNamesFrom(req))
    : ""
  const user =
    `Reply to the latest message in this thread.` +
    (req.customerName ? ` Customer first name: ${req.customerName}.` : "") +
    // Anchor relative time words so the draft never invents "tomorrow" /
    // "this weekend". The model previously had no date awareness at all.
    ` Today is ${todayLineBrisbane()} (Brisbane). Only use a relative day word ("today", "tomorrow", "this Saturday") if it is genuinely correct relative to today; otherwise name the date plainly or stay general.` +
    `\n\nThread (oldest first):\n\n` +
    renderThread(req.threadHistory) +
    (calendarBlock ? `\n\n${calendarBlock}` : "")
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
  return guardDraft(parseJson(block.text), {
    knownText:
      system + "\n" + user + "\n" + (req.customExtras ?? []).map((e) => e.content).join("\n"),
    calendarBlock,
  })
}

// Post-process to strip AI tells the model snuck through despite the prompt.
function debot(body: string): string {
  const cleaned = body
    // Internal flag names must never reach a customer.
    .replace(/\s*\(?\b(needs_human|needs_floor_layout_check|mentions_deposit|redirect_to_nbi)\b\)?/g, "")
    // A dash between numbers is a range ("10–15 guests"), not a clause break.
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2")
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
