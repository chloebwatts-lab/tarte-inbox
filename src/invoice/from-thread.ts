// Extracts the FINAL agreed booking details from a function thread so a full
// event invoice can be built automatically. Reads the whole conversation and
// takes the most recent agreed values (numbers/dates change mid-thread).

import { anthropic, MODEL } from "../llm/client.js"
import type { ParsedThread } from "../google/gmail.js"
import { renderFullThread } from "../lib/thread-text.js"
import { db } from "../db/pool.js"
import { normaliseEventDate, isIsoDate } from "../lib/dates.js"
import { config } from "../config.js"
import {
  generateInvoice,
  type LineItem,
  type GeneratedInvoice,
} from "./generate.js"

export interface InvoiceExtraction {
  booking_type: "private_hire" | "table_booking" | "unknown"
  customer_confirmed: boolean
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
  dietaries: string | null // any dietary requirements given, e.g. "2x GF, 1x vegan"
  deposit_pct: number | null
  // A FIXED save-the-date / holding deposit that staff or the thread named
  // explicitly (e.g. "a $500 deposit secures the date"), used when the package
  // and numbers aren't locked yet. Renders as a single "Save-the-date deposit"
  // line, full amount due now — never invented; null unless actually stated.
  flat_deposit_amount?: number | null
  add_ons: Array<{ description: string; unit_price: number; per_person: boolean }>
  confidence: number
  missing: string[] // what's still needed before invoicing, if any
  // Money actually received against this booking (staff-entered on the edit
  // page or bank-verified). NOT set by the thread extractor — rebuilds must
  // carry it forward from the stored editable detail, never re-derive it.
  amount_paid?: number | null
}

const SYSTEM = `You read an email thread for Tarte (a Queensland hospitality venue). A deposit invoice is raised ONLY for EXCLUSIVE PRIVATE HIRE — a whole-venue hire or a private styled function (baby shower / hens / private high tea or lunch in The Hideout or a private Tea Garden section). A plain group TABLE booking (a group just wanting a table for breakfast / brunch / lunch, e.g. the set brunch package) takes NO deposit and is NEVER invoiced.

Extract the FINAL agreed booking details and decide whether we should invoice now.

Output STRICT JSON only:
{
  "booking_type": "private_hire" | "table_booking" | "unknown",
  "customer_confirmed": <true|false>,
  "ready_to_invoice": <true|false>,
  "customer_name": "<the person's own full name, as they sign off. NOT their employer, venue, or business name, even when they book from a work address — this becomes the Xero contact Louise matches bank payments against, and a transfer from a person will never match a company. Use a business name ONLY when the booking is explicitly to be billed to that business|null>",
  "customer_email": "<email|null>",
  "event_type": "<e.g. Baby Shower|null>",
  "package_name": "<e.g. Private High Tea in The Hideout|null>",
  "venue_space": "<The Hideout|Tea Garden|Beach House|null>",
  "per_person_price": <number|null>,
  "guests": <int|null>,
  "event_date": "<YYYY-MM-DD|null>",
  "time_label": "<e.g. 11:00am - 2:00pm|null>",
  "dietaries": "<any dietary requirements/allergies the customer gave for the group, e.g. '2x gluten free, 1x vegan, 1x nut allergy'|null>",
  "deposit_pct": <number|null>,
  "flat_deposit_amount": <number|null — a FIXED save-the-date / holding deposit that was explicitly stated in the thread (by our staff or agreed with the customer), e.g. "a $500 deposit secures the date" → 500. Only when the package/per-person pricing is NOT yet locked in. null if no fixed amount was actually stated>,
  "add_ons": [{"description":"<e.g. Unlimited Drinks Package>","unit_price":<number>,"per_person":<true|false>}],
  "confidence": <0..1>,
  "missing": ["<field names still needed>"]
}

CRITICAL rules:
- booking_type: "private_hire" only when the customer clearly wants exclusive/private use or a styled private function (Hideout, private Tea Garden section, whole-venue). A group asking for a table / breakfast / brunch / lunch booking, or asking to "confirm availability", is "table_booking". If unclear, "unknown".
- customer_confirmed = true ONLY when the CUSTOMER has explicitly said they want to go ahead / lock it in / pay the deposit / "please invoice me". Merely asking for availability, prices, packages, or options is NOT confirmation.
- ready_to_invoice = true ONLY when ALL hold: booking_type is "private_hire"; customer_confirmed is true; a specific DATE is confirmed/held; the PACKAGE and a real PER-PERSON PRICE that was actually quoted in the thread are known; and the GUEST COUNT is given. In EVERY other case ready_to_invoice = false (list what's missing). When in any doubt, false.
- NEVER invent a price or a deposit. If the per-person price was not actually stated in the thread, leave per_person_price null and ready_to_invoice false. Do NOT fabricate a "$500 save-the-date" amount — but when our staff or the customer DID state a fixed holding / save-the-date deposit in the thread (e.g. "a $500 deposit secures the date", "needs $500 save the date invoice"), put that number in flat_deposit_amount so a deposit-only invoice can be raised before the package is finalised. flat_deposit_amount is separate from per_person_price and is NOT an add_on.
- STAFF INSTRUCTIONS: messages FROM our own mailbox (hello@tarte.com.au) that are notes to ourselves — a forward to hello@ with a line or two typed at the top ("needs $500 save the date invoice for hideout high tea 6th of december", "amend to 29 guests", "invoice at $89pp") — are direct instructions from our team about what to invoice. Treat them as authoritative and MORE RECENT than anything the customer wrote: take the amount / date / numbers / package they state, resolve the date, and do not list those fields as missing.
- per_person_price is the BASE package price ONLY. Anything you list in add_ons must NOT also be folded into per_person_price — the invoice adds them as separate lines, so including them in both double-charges the customer (e.g. $89 package + $10 charcuterie + $22 steak means per_person_price 89, NOT 121).
- add_ons are EXTRA CHARGEABLE ITEMS only (drinks package, grazing board, cake, styling, room hire). NEVER copy rows you see in a previously sent invoice or quote inside the thread — "Remaining balance", "Total", "Subtotal", "GST", "Deposit", "Save-the-date deposit", "Payment received", "Balance due" are invoice OUTPUTS, not add-ons. Echoing them multiplies the invoice into garbage. A deposit already paid is a PAYMENT, never an add_on line.
- Use the MOST RECENT agreed value when something changes (e.g. 32 guests later revised to 30 → 30).
- Resolve relative/partial dates ("9th August") to YYYY-MM-DD using the TODAY line. Dates must be in the future.
- customer_email: the customer's real address (not hello@tarte.com.au).`

export async function extractInvoiceDetails(
  thread: ParsedThread,
  todayBrisbane: string,
  todayWeekday: string,
  // The customer's OTHER threads with us, pre-rendered. Bookings often span
  // several chains (Bianca Zorn: price + deposit lived in older threads while
  // Make-Invoice was applied to a fresh two-message one) — without this the
  // extractor is blind to details the customer already agreed elsewhere.
  extraContext?: string
): Promise<InvoiceExtraction> {
  // Read the ENTIRE thread — final agreed numbers/dates often sit deep in a
  // long chain (Chris's rule).
  const body = renderFullThread(thread.messages)
  const staffNotes = staffInstructionNotes(thread)
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `TODAY is ${todayWeekday} ${todayBrisbane} (Australia/Brisbane).\n\nThread:\n\n${body}` +
          (staffNotes
            ? `\n\nSTAFF INSTRUCTIONS — notes our own team wrote on this thread (forwarded to ourselves). These are authoritative about WHAT to invoice; take amounts, dates, numbers and package from them and do not mark those fields missing:\n${staffNotes}`
            : "") +
          (extraContext
            ? `\n\nThe SAME customer also has these other email threads with us — agreed prices, dates, numbers and deposits may live here:\n${extraContext}`
            : ""),
      },
    ],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") return empty()
  return parse(block.text)
}

/** Lines our own team typed at the top of a forward-to-self ("needs $500 save
 *  the date invoice for hideout high tea 6th dec"). Georgia/Shawna's actual
 *  workflow (2026-08-19): forward the thread to hello@ with the instruction on
 *  top, then apply Make Invoice. Only messages FROM the mailbox that are also
 *  addressed TO it (or to nobody external) count; customer-facing replies do
 *  not. Text below the forwarded-message marker is dropped. */
export function staffInstructionNotes(thread: ParsedThread): string {
  const hello = config().HELLO_MAILBOX.toLowerCase()
  const notes: string[] = []
  for (const m of thread.messages) {
    if (!m.from.toLowerCase().includes(hello)) continue
    const rcpts = [...m.to, ...m.cc].map((r) => r.toLowerCase())
    const external = rcpts.some((r) => !r.includes("@tarte.com.au"))
    if (external) continue
    let text = m.bodyText.replace(/\r/g, "")
    const cut = text.search(/-{3,}\s*Forwarded message|^On .{5,120} wrote:$/m)
    if (cut > 0) text = text.slice(0, cut)
    text = text
      .split("\n")
      .filter((l) => !/^\s*(BOOK BEACH HOUSE|HIRE SUP|<https?:\/\/)/i.test(l))
      .join("\n")
      .trim()
    if (text.length >= 4 && text.length <= 2000) {
      notes.push(`[${m.date.toISOString().slice(0, 16).replace("T", " ")}] ${text}`)
    }
  }
  return notes.join("\n\n")
}

function empty(): InvoiceExtraction {
  return {
    booking_type: "unknown",
    customer_confirmed: false,
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
    dietaries: null,
    deposit_pct: null,
    flat_deposit_amount: null,
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
      booking_type:
        o.booking_type === "private_hire" || o.booking_type === "table_booking"
          ? o.booking_type
          : "unknown",
      customer_confirmed: o.customer_confirmed === true,
      ready_to_invoice: o.ready_to_invoice === true,
      customer_name: typeof o.customer_name === "string" ? o.customer_name : null,
      customer_email: typeof o.customer_email === "string" ? o.customer_email : null,
      event_type: typeof o.event_type === "string" ? o.event_type : null,
      package_name: typeof o.package_name === "string" ? o.package_name : null,
      venue_space: typeof o.venue_space === "string" ? o.venue_space : null,
      per_person_price: typeof o.per_person_price === "number" ? o.per_person_price : null,
      guests: typeof o.guests === "number" ? o.guests : null,
      // Tolerate a model that returns "6 December 2026" — normalise or drop.
      event_date: normaliseEventDate(o.event_date) ?? null,
      time_label: typeof o.time_label === "string" ? o.time_label : null,
      dietaries: typeof o.dietaries === "string" ? o.dietaries : null,
      deposit_pct: typeof o.deposit_pct === "number" ? o.deposit_pct : null,
      flat_deposit_amount:
        typeof o.flat_deposit_amount === "number" && o.flat_deposit_amount > 0
          ? Math.round(o.flat_deposit_amount * 100) / 100
          : null,
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

/** Relaxed gate for a HUMAN-REQUESTED invoice (staff applied the Make-Invoice
 *  label) — the human has decided to invoice, so we skip the private-hire /
 *  confirmation gates; we only need enough to produce a CORRECT invoice. */
export function manuallyInvoiceable(x: InvoiceExtraction): boolean {
  const hasMoney =
    (x.per_person_price != null && x.per_person_price > 0 && x.guests != null && x.guests > 0) ||
    x.add_ons.some((a) => a.unit_price > 0) ||
    isSaveTheDate(x)
  return Boolean(x.customer_email && isIsoDate(x.event_date) && hasMoney)
}

/** A deposit-only "save the date" invoice: staff/thread named a fixed holding
 *  deposit and the package (per-person price × guests) isn't locked yet. */
export function isSaveTheDate(x: InvoiceExtraction): boolean {
  const hasPackage = x.per_person_price != null && x.per_person_price > 0 && x.guests != null && x.guests > 0
  return !hasPackage && typeof x.flat_deposit_amount === "number" && x.flat_deposit_amount > 0
}

/** True only when there's genuinely enough to invoice — and ONLY for a
 *  confirmed EXCLUSIVE PRIVATE HIRE. Table/group dining bookings never
 *  invoice (no deposit). Fail-safe: any doubt → false. */
export function invoiceableNow(x: InvoiceExtraction): boolean {
  if (!x.ready_to_invoice) return false
  if (x.booking_type !== "private_hire") return false
  if (!x.customer_confirmed) return false
  // A real, thread-quoted per-person price + guest count (no invented save-
  // the-date amounts) and a confirmed future date.
  const hasRealPricing =
    x.per_person_price != null && x.per_person_price > 0 && x.guests != null && x.guests > 0
  return Boolean(x.customer_email && x.event_date && hasRealPricing && x.confidence >= 0.8)
}

export interface ThreadInvoiceResult extends GeneratedInvoice {
  extraction: InvoiceExtraction
}

/** Build a full event invoice from an extracted thread. Caller must have
 *  checked invoiceableNow(). When kind is "balance", produces the remaining-
 *  amount invoice (total less the deposit already paid). */
/** Derived/summary rows that must never appear as chargeable line items. The
 * extractor occasionally echoes rows from an invoice already sent in the
 * thread ("Remaining balance", "Total", "Save-the-date deposit") back as
 * add_ons — with per_person=true that turned a $2,225 high tea into a
 * $101,475 invoice (TARTE-2026-00022, caught 2026-07-30). Deposits paid are
 * payments (amount_paid), not charges. */
const SUMMARY_ROW_RE =
  /\b(remaining|balance|total|subtotal|gst|deposit|save[\s-]*the[\s-]*date|payment|paid|amount\s+due|due\s+now)\b/i

/** The one place invoice line items are derived from an extraction — shared
 * by the PDF build, the Xero draft sync, and the backfill script. */
export function lineItemsFromExtraction(x: InvoiceExtraction): LineItem[] {
  const lineItems: LineItem[] = []
  if (x.per_person_price != null && x.guests != null && x.guests > 0) {
    lineItems.push({
      description: x.package_name ?? `High Tea${x.venue_space ? ` - ${x.venue_space}` : ""}`,
      qty: x.guests,
      unitPrice: x.per_person_price,
    })
  } else if (isSaveTheDate(x)) {
    // Deposit-only invoice raised before the package is finalised. One line,
    // full amount due now; it comes off the final balance later.
    const what = x.package_name ?? `${x.venue_space ?? "Private"} function`
    lineItems.push({
      description: `Save-the-date deposit — ${what}`,
      qty: 1,
      unitPrice: x.flat_deposit_amount!,
    })
  }
  for (const a of x.add_ons) {
    if (SUMMARY_ROW_RE.test(a.description)) {
      console.warn(
        `[invoice] dropped summary-row add-on "${a.description}" ($${a.unit_price}${a.per_person ? " pp" : ""}) — derived totals are never line items`
      )
      continue
    }
    lineItems.push({
      description: a.description,
      qty: a.per_person && x.guests ? x.guests : 1,
      unitPrice: a.unit_price,
    })
  }
  return lineItems
}

export async function buildInvoiceFromExtraction(
  x: InvoiceExtraction,
  opts: {
    bookingId: number | null
    threadId: string
    todayBrisbane: string
    kind?: "standard" | "balance"
  }
): Promise<ThreadInvoiceResult> {
  const kind = opts.kind ?? "standard"
  const lineItems = lineItemsFromExtraction(x)
  const dateLabel = x.event_date
    ? new Date(`${x.event_date}T00:00:00+10:00`).toLocaleDateString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : undefined
  // Table bookings take NO deposit (Chris's standing rule — deposits are for
  // exclusive private hire only). Staff can still request an invoice for one
  // via Make-Invoice; it must show the full amount due, not a 50% split.
  const isTableBooking = x.booking_type === "table_booking"
  const depositPct = isTableBooking ? null : (x.deposit_pct ?? 50)
  const gross = lineItems.reduce((s, li) => s + li.qty * li.unitPrice, 0)
  const depositPaid = Math.round((gross * (depositPct ?? 50)) / 100 * 100) / 100
  // Never print a due date that's already in the past (e.g. "deposit due two
  // weeks prior" when the event is tomorrow).
  const todayB = opts.todayBrisbane
  const dueLabelIfFuture = (daysBefore: number): string | undefined => {
    // A malformed date must never take the whole build down (it 500'd the
    // /invoice/new form on 2026-08-19); just print no due line.
    if (!isIsoDate(x.event_date)) return undefined
    const due = new Date(Date.UTC(
      Number(x.event_date.slice(0, 4)),
      Number(x.event_date.slice(5, 7)) - 1,
      Number(x.event_date.slice(8, 10)) - daysBefore
    ))
    return due.toISOString().slice(0, 10) >= todayB ? fmtDue(x.event_date, daysBefore) : undefined
  }
  const tableNotes = [
    "Full amount due prior to the booking.",
    "Final numbers and dietaries required 2 days prior to the booking.",
    "Dietary requirements may incur an additional fee.",
  ]
  const balanceNotes = [
    "Deposit already received — thank you.",
    "Balance above is the remaining amount due.",
    "Balance due 2 days prior to the event start time.",
    "Final numbers and dietaries required 2 days prior to the event.",
  ]
  const amountPaid =
    typeof x.amount_paid === "number" && x.amount_paid > 0
      ? Math.round(x.amount_paid * 100) / 100
      : null
  const fullyPaid = amountPaid != null && amountPaid >= gross - 0.005
  const paidNotes = [
    "Paid in full — thank you. Nothing owing.",
    "Final numbers and dietaries required 2 days prior to the event.",
  ]
  const saveTheDate = kind === "standard" && isSaveTheDate(x)
  const saveTheDateNotes = [
    "This save-the-date deposit holds your date and is applied toward your final balance.",
    "Once your package and guest numbers are confirmed, a further invoice follows per our booking conditions.",
    "Final numbers and dietaries required 2 days prior to the event.",
    "Dietary requirements may incur an additional fee.",
  ]
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
      dietaries: x.dietaries ?? undefined,
    },
    lineItems,
    kind,
    depositPct: kind === "balance" || fullyPaid || saveTheDate ? null : depositPct,
    depositPaidAmount: kind === "balance" ? amountPaid ?? depositPaid : null,
    amountPaid,
    todayBrisbane: opts.todayBrisbane,
    depositDueLabel:
      kind === "balance" || depositPct === null || fullyPaid || saveTheDate ? undefined : dueLabelIfFuture(14),
    totalDueLabel: fullyPaid
      ? undefined
      : saveTheDate
        ? "On receipt — payment secures your date"
        : dueLabelIfFuture(2),
    notes: fullyPaid
      ? paidNotes
      : kind === "balance"
        ? balanceNotes
        : saveTheDate
          ? saveTheDateNotes
          : isTableBooking
            ? tableNotes
            : undefined,
  })
  // Persist the editable detail so staff can tweak a field and regenerate.
  await db()
    .query(`UPDATE inbox_invoices SET editable = $1 WHERE invoice_number = $2`, [
      JSON.stringify(x),
      gen.invoiceNumber,
    ])
    .catch((e) => console.error("[invoice] failed to persist editable detail:", e instanceof Error ? e.message : e))
  // Mirror into Xero as a DRAFT dated the EVENT date so Louise can approve
  // and apply payments to the right period. Best-effort — a Xero hiccup must
  // never block the customer invoice.
  await syncXeroEventDraft(gen.invoiceNumber, opts.threadId, x, lineItems).catch((e) =>
    console.error("[invoice] xero event-draft sync failed:", e instanceof Error ? e.message : e)
  )
  return { ...gen, extraction: x }
}

/** One DRAFT Xero invoice per event thread, dated the event date, upserted on
 * every rebuild. Skipped when the event date or customer email is unknown. */
export async function syncXeroEventDraft(
  invoiceNumber: string,
  threadId: string,
  x: InvoiceExtraction,
  lineItems: LineItem[]
): Promise<void> {
  if (!x.event_date || !x.customer_email) return
  // Manual invoices carry no thread — without a stable key the upsert would
  // mint a fresh Xero draft on every regenerate, so skip those.
  if (!threadId) return
  const gross = lineItems.reduce((s, li) => s + li.qty * li.unitPrice, 0)
  if (gross <= 0) return
  const { findOrCreateContact, upsertEventDraftInvoice, resolveOnlineSalesAccountCode } =
    await import("../xero/client.js")
  // Matt's rule (28 Jul 2026): standalone cake/goods orders belong with the
  // Stripe website cakes in 44097 Sales - Online, not Event Sales. A function
  // is anything with a per-person package; a cake order has goods lines only.
  const isCakeOrder =
    x.per_person_price == null &&
    lineItems.length > 0 &&
    lineItems.some((li) => /cake|croquembouche|dessert|pastry box|croissant box/i.test(li.description))
  const goodsAccountCode = isCakeOrder ? await resolveOnlineSalesAccountCode() : undefined
  const existing = await db().query<{ xero_invoice_id: string }>(
    `SELECT xero_invoice_id FROM inbox_invoices
      WHERE thread_id = $1 AND thread_id <> '' AND xero_invoice_id IS NOT NULL
      ORDER BY id LIMIT 1`,
    [threadId]
  )
  const contactId = await findOrCreateContact(x.customer_email, x.customer_name ?? x.customer_email)
  // One Xero draft per event thread, but a thread can hold two TARTE numbers
  // (deposit + balance). Anchor the Xero invoice number to the thread's FIRST
  // number so it never flips between rebuilds.
  const firstNum = await db().query<{ invoice_number: string }>(
    `SELECT invoice_number FROM inbox_invoices
      WHERE thread_id = $1 AND invoice_number <> 'PENDING'
      ORDER BY id LIMIT 1`,
    [threadId]
  )
  // The Xero invoice number is anchored to the thread's first TARTE number so
  // it can't flip between rebuilds, so the reference has to use the same anchor
  // or the two disagree — Janine Reed 31 Jul 2026 sat in Xero as invoice 00015
  // with reference 00016, and Louise had no way to tell which the customer
  // held. Where the thread has since raised a later number (deposit, then
  // balance), name both so a payment quoting either one still matches.
  const anchorNumber = firstNum.rows[0]?.invoice_number ?? invoiceNumber
  const numberLabel =
    invoiceNumber === anchorNumber ? anchorNumber : `${anchorNumber} + ${invoiceNumber}`
  const result = await upsertEventDraftInvoice({
    existingInvoiceId: existing.rows[0]?.xero_invoice_id ?? null,
    contactId,
    reference: `${numberLabel} | EVENT ${x.event_date}`,
    invoiceNumber: anchorNumber,
    eventDate: x.event_date,
    lines: lineItems.map((li) => ({
      description: li.description,
      quantity: li.qty,
      unitAmount: li.unitPrice,
      accountCode: goodsAccountCode,
    })),
  })
  await db().query(`UPDATE inbox_invoices SET xero_invoice_id = $1 WHERE invoice_number = $2`, [
    result.invoiceId,
    invoiceNumber,
  ])
  if (!result.updated) {
    console.warn(`[invoice] xero ${result.invoiceId} NOT updated for ${invoiceNumber}: ${result.skippedReason}`)
    const { notifyStaff } = await import("./cancellation.js")
    await notifyStaff(
      `Xero invoice needs a manual update (${invoiceNumber})`,
      `The booking behind ${invoiceNumber} changed (event ${x.event_date}, ${x.customer_name ?? x.customer_email}), ` +
        `but its Xero invoice was not touched because: ${result.skippedReason}.\n\n` +
        `Please update the Xero invoice by hand so it matches the latest customer invoice, ` +
        `then apply any payments as usual.`
    ).catch(() => {})
    return
  }
  console.log(`[invoice] xero DRAFT ${result.invoiceId} synced for ${invoiceNumber} (event ${x.event_date})`)
}
