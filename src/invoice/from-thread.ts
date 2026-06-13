// Extracts the FINAL agreed booking details from a function thread so a full
// event invoice can be built automatically. Reads the whole conversation and
// takes the most recent agreed values (numbers/dates change mid-thread).

import { anthropic, MODEL } from "../llm/client.js"
import type { ParsedThread } from "../google/gmail.js"
import { dequote } from "../lib/dequote.js"
import {
  generateInvoice,
  type LineItem,
  type GeneratedInvoice,
} from "./generate.js"

export interface InvoiceExtraction {
  ready_to_invoice: boolean
  customer_name: string | null
  customer_email: string | null
  event_type: string | null
  package_name: string | null
  venue_space: string | null // "The Hideout" | "Tea Garden" | "Beach House"
  per_person_price: number | null
  guests: number | null
  event_date: string | null // YYYY-MM-DD
  time_label: string | null // e.g. "11:00am - 2:00pm"
  deposit_pct: number | null
  add_ons: Array<{ description: string; unit_price: number; per_person: boolean }>
  confidence: number
  missing: string[] // what's still needed before invoicing, if any
}

const SYSTEM = `You read an email thread for Tarte (a Queensland hospitality venue) about a FUNCTION/EVENT booking (high tea, baby shower, hens, private lunch in The Hideout or Tea Garden). Extract the FINAL agreed booking details so we can raise a deposit invoice.

Output STRICT JSON only:
{
  "ready_to_invoice": <true|false>,
  "customer_name": "<string|null>",
  "customer_email": "<email|null>",
  "event_type": "<e.g. Baby Shower|null>",
  "package_name": "<e.g. Private High Tea in The Hideout|null>",
  "venue_space": "<The Hideout|Tea Garden|Beach House|null>",
  "per_person_price": <number|null>,
  "guests": <int|null>,
  "event_date": "<YYYY-MM-DD|null>",
  "time_label": "<e.g. 11:00am - 2:00pm|null>",
  "deposit_pct": <number|null>,
  "add_ons": [{"description":"<e.g. Unlimited Drinks Package>","unit_price":<number>,"per_person":<true|false>}],
  "confidence": <0..1>,
  "missing": ["<field names still needed>"]
}

CRITICAL rules:
- Use the MOST RECENT agreed value when something changes. If the customer first said 32 guests then later "I would look to have 30", the answer is 30. If a date was held then changed, use the latest confirmed/held one.
- ready_to_invoice = true ONLY when ALL of these are settled in the thread: a specific event DATE is confirmed or held by Tarte, the PACKAGE and PER-PERSON PRICE are known, the GUEST COUNT is given, and the conversation has moved to securing/deposit/invoice. Otherwise false, and list what's missing.
- Resolve relative/partial dates ("9th August", "Sunday the 9th") to YYYY-MM-DD using the TODAY line provided. Dates should be in the future.
- deposit_pct defaults to 50 unless the thread says otherwise (a flat save-the-date amount like $500 → set per_person_price null, put the $500 as an add_on line "Save-the-date deposit" and deposit_pct 100).
- Tea Garden / Beach House high tea is usually $89pp in The Hideout; don't invent a price if it's not in the thread — leave per_person_price null and mark missing.
- Guests must be the count to INVOICE for now (final-ish); note that numbers can be adjusted before final payment.
- customer_email: the customer's real address (not hello@tarte.com.au).`

export async function extractInvoiceDetails(
  thread: ParsedThread,
  todayBrisbane: string,
  todayWeekday: string
): Promise<InvoiceExtraction> {
  const body = thread.messages
    .map((m) => `[${m.date.toISOString().slice(0, 10)}] ${m.from}:\n${dequote(m.bodyText).slice(0, 2500)}`)
    .join("\n\n---\n\n")
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `TODAY is ${todayWeekday} ${todayBrisbane} (Australia/Brisbane).\n\nThread:\n\n${body.slice(0, 14000)}`,
      },
    ],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") return empty()
  return parse(block.text)
}

function empty(): InvoiceExtraction {
  return {
    ready_to_invoice: false,
    customer_name: null,
    customer_email: null,
    event_type: null,
    package_name: null,
    venue_space: null,
    per_person_price: null,
    guests: null,
    event_date: null,
    time_label: null,
    deposit_pct: null,
    add_ons: [],
    confidence: 0,
    missing: ["unparseable"],
  }
}

function parse(text: string): InvoiceExtraction {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return empty()
  try {
    const o = JSON.parse(m[0]) as Partial<InvoiceExtraction>
    return {
      ready_to_invoice: o.ready_to_invoice === true,
      customer_name: typeof o.customer_name === "string" ? o.customer_name : null,
      customer_email: typeof o.customer_email === "string" ? o.customer_email : null,
      event_type: typeof o.event_type === "string" ? o.event_type : null,
      package_name: typeof o.package_name === "string" ? o.package_name : null,
      venue_space: typeof o.venue_space === "string" ? o.venue_space : null,
      per_person_price: typeof o.per_person_price === "number" ? o.per_person_price : null,
      guests: typeof o.guests === "number" ? o.guests : null,
      event_date: typeof o.event_date === "string" ? o.event_date : null,
      time_label: typeof o.time_label === "string" ? o.time_label : null,
      deposit_pct: typeof o.deposit_pct === "number" ? o.deposit_pct : null,
      add_ons: Array.isArray(o.add_ons)
        ? o.add_ons
            .filter((a): a is { description: string; unit_price: number; per_person: boolean } =>
              !!a && typeof a.description === "string" && typeof a.unit_price === "number"
            )
            .map((a) => ({ description: a.description, unit_price: a.unit_price, per_person: a.per_person === true }))
        : [],
      confidence: typeof o.confidence === "number" ? o.confidence : 0,
      missing: Array.isArray(o.missing) ? o.missing.map(String) : [],
    }
  } catch {
    return empty()
  }
}

function fmtDue(eventDate: string, daysBefore: number): string {
  const [y, mo, d] = eventDate.split("-").map(Number) as [number, number, number]
  const due = new Date(Date.UTC(y, mo - 1, d - daysBefore))
  return due.toLocaleDateString("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

/** True only when there's enough to produce a correct invoice. */
export function invoiceableNow(x: InvoiceExtraction): boolean {
  if (!x.ready_to_invoice) return false
  const hasMoney =
    (x.per_person_price != null && x.guests != null && x.guests > 0) ||
    x.add_ons.length > 0
  return Boolean(x.customer_email && x.event_date && hasMoney && x.confidence >= 0.7)
}

export interface ThreadInvoiceResult extends GeneratedInvoice {
  extraction: InvoiceExtraction
}

/** Build a full event invoice from an extracted thread. Caller must have
 *  checked invoiceableNow(). */
export async function buildInvoiceFromExtraction(
  x: InvoiceExtraction,
  opts: { bookingId: number | null; threadId: string; todayBrisbane: string }
): Promise<ThreadInvoiceResult> {
  const lineItems: LineItem[] = []
  if (x.per_person_price != null && x.guests != null && x.guests > 0) {
    lineItems.push({
      description: x.package_name ?? `High Tea${x.venue_space ? ` — ${x.venue_space}` : ""}`,
      qty: x.guests,
      unitPrice: x.per_person_price,
    })
  }
  for (const a of x.add_ons) {
    lineItems.push({
      description: a.description,
      qty: a.per_person && x.guests ? x.guests : 1,
      unitPrice: a.unit_price,
    })
  }
  const dateLabel = x.event_date
    ? new Date(`${x.event_date}T00:00:00+10:00`).toLocaleDateString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : undefined
  const gen = await generateInvoice({
    bookingId: opts.bookingId,
    threadId: opts.threadId,
    customerName: x.customer_name ?? "",
    customerEmail: x.customer_email ?? "",
    event: {
      eventType: x.event_type ?? undefined,
      packageName: x.package_name ?? undefined,
      dateLabel,
      timeLabel: x.time_label ?? undefined,
      guestsLabel: x.guests != null ? `${x.guests} Adults` : undefined,
    },
    lineItems,
    depositPct: x.deposit_pct ?? 50,
    todayBrisbane: opts.todayBrisbane,
    depositDueLabel: x.event_date ? fmtDue(x.event_date, 14) : undefined,
    totalDueLabel: x.event_date ? fmtDue(x.event_date, 2) : undefined,
  })
  return { ...gen, extraction: x }
}
