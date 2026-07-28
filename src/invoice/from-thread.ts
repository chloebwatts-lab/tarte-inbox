// Extracts the FINAL agreed booking details from a function thread so a full
// event invoice can be built automatically. Reads the whole conversation and
// takes the most recent agreed values (numbers/dates change mid-thread).

import { anthropic, MODEL } from "../llm/client.js"
import type { ParsedThread } from "../google/gmail.js"
import { renderFullThread } from "../lib/thread-text.js"
import { db } from "../db/pool.js"
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
  "customer_name": "<string|null>",
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
  "add_ons": [{"description":"<e.g. Unlimited Drinks Package>","unit_price":<number>,"per_person":<true|false>}],
  "confidence": <0..1>,
  "missing": ["<field names still needed>"]
}

CRITICAL rules:
- booking_type: "private_hire" only when the customer clearly wants exclusive/private use or a styled private function (Hideout, private Tea Garden section, whole-venue). A group asking for a table / breakfast / brunch / lunch booking, or asking to "confirm availability", is "table_booking". If unclear, "unknown".
- customer_confirmed = true ONLY when the CUSTOMER has explicitly said they want to go ahead / lock it in / pay the deposit / "please invoice me". Merely asking for availability, prices, packages, or options is NOT confirmation.
- ready_to_invoice = true ONLY when ALL hold: booking_type is "private_hire"; customer_confirmed is true; a specific DATE is confirmed/held; the PACKAGE and a real PER-PERSON PRICE that was actually quoted in the thread are known; and the GUEST COUNT is given. In EVERY other case ready_to_invoice = false (list what's missing). When in any doubt, false.
- NEVER invent a price or a deposit. If the per-person price was not actually stated in the thread, leave per_person_price null and ready_to_invoice false. Do NOT fabricate a "$500 save-the-date" line — only include a deposit/amount the thread actually agreed.
- per_person_price is the BASE package price ONLY. Anything you list in add_ons must NOT also be folded into per_person_price — the invoice adds them as separate lines, so including them in both double-charges the customer (e.g. $89 package + $10 charcuterie + $22 steak means per_person_price 89, NOT 121).
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
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `TODAY is ${todayWeekday} ${todayBrisbane} (Australia/Brisbane).\n\nThread:\n\n${body}` +
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
      event_date: typeof o.event_date === "string" ? o.event_date : null,
      time_label: typeof o.time_label === "string" ? o.time_label : null,
      dietaries: typeof o.dietaries === "string" ? o.dietaries : null,
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

/** Relaxed gate for a HUMAN-REQUESTED invoice (staff applied the Make-Invoice
 *  label) — the human has decided to invoice, so we skip the private-hire /
 *  confirmation gates; we only need enough to produce a CORRECT invoice. */
export function manuallyInvoiceable(x: InvoiceExtraction): boolean {
  const hasMoney =
    (x.per_person_price != null && x.per_person_price > 0 && x.guests != null && x.guests > 0) ||
    x.add_ons.some((a) => a.unit_price > 0)
  return Boolean(x.customer_email && x.event_date && hasMoney)
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
/** The one place invoice line items are derived from an extraction — shared
 * by the PDF build, the Xero draft sync, and the backfill script. */
export function lineItemsFromExtraction(x: InvoiceExtraction): LineItem[] {
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
    if (!x.event_date) return undefined
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
    depositPct: kind === "balance" || fullyPaid ? null : depositPct,
    depositPaidAmount: kind === "balance" ? amountPaid ?? depositPaid : null,
    amountPaid,
    todayBrisbane: opts.todayBrisbane,
    depositDueLabel:
      kind === "balance" || depositPct === null || fullyPaid ? undefined : dueLabelIfFuture(14),
    totalDueLabel: fullyPaid ? undefined : dueLabelIfFuture(2),
    notes: fullyPaid ? paidNotes : kind === "balance" ? balanceNotes : isTableBooking ? tableNotes : undefined,
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
  const { findOrCreateContact, upsertEventDraftInvoice } = await import("../xero/client.js")
  const existing = await db().query<{ xero_invoice_id: string }>(
    `SELECT xero_invoice_id FROM inbox_invoices
      WHERE thread_id = $1 AND thread_id <> '' AND xero_invoice_id IS NOT NULL
      ORDER BY id LIMIT 1`,
    [threadId]
  )
  const contactId = await findOrCreateContact(x.customer_email, x.customer_name ?? x.customer_email)
  const result = await upsertEventDraftInvoice({
    existingInvoiceId: existing.rows[0]?.xero_invoice_id ?? null,
    contactId,
    reference: `${invoiceNumber} | EVENT ${x.event_date}`,
    eventDate: x.event_date,
    lines: lineItems.map((li) => ({
      description: li.description,
      quantity: li.qty,
      unitAmount: li.unitPrice,
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
