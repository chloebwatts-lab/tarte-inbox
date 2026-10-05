// JSON API for the Tarte Functions app (Georgia's Expo + Supabase app).
//
// Her app cannot hold Google credentials itself (the Workspace service-account
// route needs Super Admin), but this service already acts as hello@ for Gmail
// and Calendar and already owns the invoice generator. So the app calls here:
//
//   POST /fn/invoice                    create or regenerate a function's deposit / balance invoice
//   GET  /fn/invoices?function_id=      the invoices stored against a function
//   GET  /fn/invoice/:number/pdf        the PDF itself
//   POST /fn/invoice/:number/draft-email  put a draft (PDF attached) in hello@ Drafts
//   GET  /fn/enquiries                  function enquiries the inbox has parsed
//   POST /fn/calendar                   push a function onto the functions calendar
//
// Invoices are keyed on the app's own function id: thread_id = "fn:<id>". That
// gives the same per-event behaviour the Gmail flow has (one number per kind,
// deposit + balance sharing one Xero draft). Nothing reaches Xero or a
// customer until a draft email is created, so the app can generate and edit
// freely first.

import { Hono } from "hono"
import { cors } from "hono/cors"
import { createHash, timingSafeEqual } from "node:crypto"
import { google } from "googleapis"
import { config } from "./config.js"
import { db } from "./db/pool.js"
import { upsertThread } from "./db/queries.js"
import { ensureGoogleAuthed } from "./google/oauth.js"
import { applyLabel, createStandaloneDraftWithThread, deleteDraft } from "./google/gmail.js"
import { ensureCombinedCalendar } from "./google/calendar-sync.js"
import { invoiceConfigReady } from "./invoice/generate.js"
import {
  buildInvoiceFromExtraction,
  lineItemsFromExtraction,
  syncXeroEventDraft,
  isSaveTheDate,
  type InvoiceExtraction,
} from "./invoice/from-thread.js"
import { normaliseEventDate } from "./lib/dates.js"
import { ACTION_LABEL, INVOICE_BCC, INVOICE_CREATED_LABEL, invoiceSubjectSuffix } from "./pipeline.js"

export type FnInvoiceKind = "deposit" | "balance"

export interface FnInvoiceFields {
  customer_name?: string
  customer_email?: string
  event_type?: string
  package_name?: string
  venue_space?: string
  event_date?: string
  time_label?: string
  dietaries?: string
  guests?: number
  per_person_price?: number
  deposit_pct?: number
  flat_deposit_amount?: number
  amount_paid?: number
  paid_in_full?: boolean
  add_ons?: Array<{ description: string; unit_price: number; per_person: boolean }>
}

export const fnThreadKey = (functionId: string): string => `fn:${functionId}`
const dbKind = (k: FnInvoiceKind): "standard" | "balance" => (k === "balance" ? "balance" : "standard")
const round2 = (n: number): number => Math.round(n * 100) / 100

function todayBrisbane(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(new Date())
}

/** Merge the app's fields over what is already stored for the function.
 * A field left out keeps its stored value; add_ons, when sent, replace the
 * stored list wholesale. Pure, so it is unit-testable. */
export function mergeFnFields(base: InvoiceExtraction | null, f: FnInvoiceFields): InvoiceExtraction {
  const b: InvoiceExtraction = base ?? {
    booking_type: "private_hire",
    customer_confirmed: true,
    ready_to_invoice: true,
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
    deposit_pct: 50,
    flat_deposit_amount: null,
    add_ons: [],
    confidence: 1,
    missing: [],
  }
  const x: InvoiceExtraction = {
    ...b,
    customer_name: f.customer_name ?? b.customer_name,
    customer_email: f.customer_email ?? b.customer_email,
    event_type: f.event_type ?? b.event_type,
    package_name: f.package_name ?? b.package_name,
    venue_space: f.venue_space ?? b.venue_space,
    per_person_price: f.per_person_price ?? b.per_person_price,
    guests: f.guests ?? b.guests,
    event_date: f.event_date ?? b.event_date,
    time_label: f.time_label ?? b.time_label,
    dietaries: f.dietaries ?? b.dietaries,
    deposit_pct: f.deposit_pct ?? b.deposit_pct,
    flat_deposit_amount: f.flat_deposit_amount ?? b.flat_deposit_amount ?? null,
    amount_paid: f.amount_paid ?? b.amount_paid ?? null,
    add_ons: f.add_ons ?? b.add_ons,
  }
  if (f.paid_in_full) {
    x.amount_paid = round2(lineItemsFromExtraction(x).reduce((s, li) => s + li.qty * li.unitPrice, 0))
  }
  return x
}

/** What is wrong with the fields, in words the app can show; null when the
 * invoice can be built. */
export function fnInvoiceProblem(x: InvoiceExtraction): string | null {
  if (!x.customer_name || !x.customer_email) return "customer name and email are required"
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.customer_email)) return `"${x.customer_email}" is not an email address`
  const total = lineItemsFromExtraction(x).reduce((s, li) => s + li.qty * li.unitPrice, 0)
  if (total <= 0) return "enter guests and price per person, a save-the-date deposit, or at least one priced line"
  return null
}

export interface FnInvoiceSummary {
  invoice_number: string
  kind: FnInvoiceKind
  function_id: string
  total: number
  deposit_amount: number | null
  amount_paid: number
  balance_due: number
  paid_in_full: boolean
  lines: Array<{ description: string; qty: number; unit_price: number; amount: number }>
  fields: InvoiceExtraction
  pdf_path: string
  drafted_at: string | null
  draft_url: string | null
  in_xero: boolean
  created_at: string
}

interface FnInvoiceRow {
  invoice_number: string
  kind: "standard" | "balance"
  thread_id: string
  editable: InvoiceExtraction | null
  draft_id: string | null
  draft_thread_id: string | null
  drafted_at: Date | null
  xero_invoice_id: string | null
  created_at: Date
}

const ROW_COLS = `invoice_number, kind, thread_id, editable, draft_id, draft_thread_id, drafted_at, xero_invoice_id, created_at`

export function summariseFnInvoice(r: FnInvoiceRow): FnInvoiceSummary {
  const x = r.editable as InvoiceExtraction
  const lines = lineItemsFromExtraction(x).map((li) => ({
    description: li.description,
    qty: li.qty,
    unit_price: li.unitPrice,
    amount: round2(li.qty * li.unitPrice),
  }))
  const total = round2(lines.reduce((s, l) => s + l.amount, 0))
  const paid = round2(Math.max(0, x.amount_paid ?? 0))
  const pct = x.deposit_pct ?? 50
  const deposit = isSaveTheDate(x) ? total : round2((total * pct) / 100)
  // A balance invoice with no payment recorded prints the % deposit as
  // received (same as the PDF), so the summary has to agree with it.
  const received = paid > 0 ? paid : r.kind === "balance" ? deposit : 0
  return {
    invoice_number: r.invoice_number,
    kind: r.kind === "balance" ? "balance" : "deposit",
    function_id: r.thread_id.replace(/^fn:/, ""),
    total,
    deposit_amount: deposit,
    amount_paid: paid,
    balance_due: round2(Math.max(0, total - received)),
    paid_in_full: paid > 0 && paid >= total - 0.005,
    lines,
    fields: x,
    pdf_path: `/fn/invoice/${encodeURIComponent(r.invoice_number)}/pdf`,
    drafted_at: r.drafted_at ? new Date(r.drafted_at).toISOString() : null,
    draft_url: r.draft_thread_id ? `https://mail.google.com/mail/u/0/#all/${r.draft_thread_id}` : null,
    in_xero: !!r.xero_invoice_id,
    created_at: new Date(r.created_at).toISOString(),
  }
}

async function fnRows(functionId: string): Promise<FnInvoiceRow[]> {
  const { rows } = await db().query<FnInvoiceRow>(
    `SELECT ${ROW_COLS} FROM inbox_invoices
      WHERE thread_id = $1 AND invoice_number <> 'PENDING' AND editable IS NOT NULL
      ORDER BY id`,
    [fnThreadKey(functionId)]
  )
  return rows
}

async function fnRowByNumber(invoiceNumber: string): Promise<FnInvoiceRow | null> {
  const { rows } = await db().query<FnInvoiceRow>(
    `SELECT ${ROW_COLS} FROM inbox_invoices
      WHERE invoice_number = $1 AND thread_id LIKE 'fn:%' AND editable IS NOT NULL LIMIT 1`,
    [invoiceNumber]
  )
  return rows[0] ?? null
}

/** Create the function's invoice of this kind, or regenerate it with the new
 * fields (same invoice number). The other kind, when it exists, is rebuilt
 * from the same numbers so deposit and balance never drift apart. */
export async function upsertFunctionInvoice(
  functionId: string,
  kind: FnInvoiceKind,
  fields: FnInvoiceFields
): Promise<{ ok: true; invoice: FnInvoiceSummary } | { ok: false; error: string }> {
  if (!invoiceConfigReady()) return { ok: false, error: "invoice config not set on the server" }
  const rows = await fnRows(functionId)
  const mine = rows.find((r) => r.kind === dbKind(kind))
  const sibling = rows.find((r) => r.kind !== dbKind(kind))
  const x = mergeFnFields(mine?.editable ?? sibling?.editable ?? null, fields)
  const today = todayBrisbane()
  if (x.event_date) {
    const norm = normaliseEventDate(x.event_date, today)
    if (!norm) return { ok: false, error: `couldn't read the date "${x.event_date}". Send it like 06/12/2026 or 2026-12-06.` }
    x.event_date = norm
  }
  const problem = fnInvoiceProblem(x)
  if (problem) return { ok: false, error: problem }

  // Xero only hears about a function once an invoice email has been drafted
  // for it; after that every regenerate keeps the Xero draft in step.
  const live = rows.some((r) => r.drafted_at || r.xero_invoice_id)
  const threadId = fnThreadKey(functionId)
  const built = await buildInvoiceFromExtraction(x, {
    bookingId: null,
    threadId,
    todayBrisbane: today,
    kind: dbKind(kind),
    skipXero: !live,
  })
  if (sibling) {
    await buildInvoiceFromExtraction(x, {
      bookingId: null,
      threadId,
      todayBrisbane: today,
      kind: sibling.kind,
      skipXero: true,
    }).catch((e) => console.error("[fn] sibling rebuild failed:", e instanceof Error ? e.message : e))
  }
  const row = await fnRowByNumber(built.invoiceNumber)
  if (!row) return { ok: false, error: "invoice was built but could not be read back" }
  console.log(`[fn] ${mine ? "regenerated" : "created"} ${built.invoiceNumber} (${kind}) for function ${functionId}`)
  return { ok: true, invoice: summariseFnInvoice(row) }
}

export function defaultFnEmail(x: InvoiceExtraction, kind: FnInvoiceKind): string {
  const first = (x.customer_name ?? "there").split(/\s+/)[0]
  const niceDate = x.event_date
    ? new Date(`${x.event_date}T00:00:00+10:00`).toLocaleDateString("en-AU", {
        timeZone: "Australia/Brisbane",
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    : null
  const total = round2(lineItemsFromExtraction(x).reduce((s, li) => s + li.qty * li.unitPrice, 0))
  const paid = round2(Math.max(0, x.amount_paid ?? 0))
  const sign = `Kind Regards,\nTarte Management`
  if (kind === "balance") {
    const due = round2(Math.max(0, total - (paid || round2((total * (x.deposit_pct ?? 50)) / 100))))
    return (
      `Hi ${first},\n\n` +
      `Thank you for your deposit. Please find the invoice for your remaining balance attached${niceDate ? `, for your booking on ${niceDate}` : ""}. ` +
      `The balance of $${due.toFixed(2)} is due 2 days prior to the event, along with your final numbers and dietaries.\n\n` +
      sign
    )
  }
  if (isSaveTheDate(x)) {
    return (
      `Hi ${first},\n\n` +
      `Thank you for booking with us${niceDate ? ` for ${niceDate}` : ""}, please find your save-the-date deposit invoice attached. ` +
      `Paying the $${total.toFixed(2)} deposit secures your date, and it comes off your final balance once your package and numbers are confirmed.\n\n` +
      sign
    )
  }
  const pct = x.deposit_pct ?? 50
  return (
    `Hi ${first},\n\n` +
    `Thank you for booking with us${niceDate ? ` for ${niceDate}` : ""}, please find your deposit invoice attached. ` +
    `Paying the ${pct}% deposit ($${round2((total * pct) / 100).toFixed(2)}) secures your date, and final numbers and dietaries can be confirmed closer to the day.\n\n` +
    sign
  )
}

/** Put a draft email to the customer, invoice PDF attached, in hello@ Drafts.
 * Never sends. Pressing it again replaces the earlier unsent draft. This is
 * also the point the function's Xero draft (dated the event day) is made. */
export async function draftFunctionInvoiceEmail(
  invoiceNumber: string,
  opts: { subject?: string; body?: string }
): Promise<{ ok: true; invoice: FnInvoiceSummary } | { ok: false; error: string }> {
  const row = await fnRowByNumber(invoiceNumber)
  if (!row || !row.editable) return { ok: false, error: "invoice not found" }
  const x = row.editable
  if (!x.customer_email) return { ok: false, error: "the invoice has no customer email" }
  const pdf = await db().query<{ pdf_bytes: Buffer | null }>(
    `SELECT pdf_bytes FROM inbox_invoices WHERE invoice_number = $1`,
    [invoiceNumber]
  )
  const bytes = pdf.rows[0]?.pdf_bytes
  if (!bytes) return { ok: false, error: "the invoice has no stored PDF, regenerate it first" }

  const kind: FnInvoiceKind = row.kind === "balance" ? "balance" : "deposit"
  if (row.draft_id) await deleteDraft(row.draft_id)
  const safeName = (x.customer_name ?? "customer").replace(/[^A-Za-z0-9 ]/g, "").trim()
  const { draftId, threadId } = await createStandaloneDraftWithThread(
    x.customer_email,
    opts.subject?.trim() ||
      `Your booking with Tarte${invoiceSubjectSuffix(x.event_date, invoiceNumber)}`,
    opts.body?.trim() || defaultFnEmail(x, kind),
    config().HELLO_MAILBOX,
    "Tarte Team",
    [
      {
        filename: `${invoiceNumber} - ${safeName}${kind === "balance" ? " (Balance)" : ""}.pdf`,
        contentType: "application/pdf",
        data: bytes,
      },
    ],
    INVOICE_BCC
  )
  await db().query(
    `UPDATE inbox_invoices SET draft_id = $1, draft_thread_id = $2, drafted_at = now() WHERE invoice_number = $3`,
    [draftId, threadId, invoiceNumber]
  )
  await upsertThread({
    thread_id: threadId,
    last_message_id: "manual_invoice",
    state: "drafted",
    last_action: "drafted",
    meta: { manualInvoice: true, invoiceNumber, functionRef: row.thread_id },
  })
  await applyLabel(threadId, INVOICE_CREATED_LABEL).catch(() => {})
  await applyLabel(threadId, ACTION_LABEL).catch(() => {})
  await syncXeroEventDraft(invoiceNumber, row.thread_id, x, lineItemsFromExtraction(x)).catch((e) =>
    console.error("[fn] xero event-draft sync failed:", e instanceof Error ? e.message : e)
  )
  console.log(`[fn] drafted ${invoiceNumber} to ${x.customer_email} (gmail thread ${threadId})`)
  const fresh = await fnRowByNumber(invoiceNumber)
  return { ok: true, invoice: summariseFnInvoice(fresh ?? row) }
}

// --- Enquiries ---

export function enquiryStatus(state: string): "confirmed" | "pending" | "cancelled" {
  if (state === "cancelled") return "cancelled"
  return state === "deposit_paid" || state === "balance_invoiced" || state === "paid" ? "confirmed" : "pending"
}

async function listEnquiries(days: number): Promise<unknown[]> {
  const { rows } = await db().query<{
    id: number
    thread_id: string
    venue: string
    state: string
    customer_email: string | null
    customer_name: string | null
    pax: number | null
    event_date: string | null
    event_start: Date | null
    event_end: Date | null
    created_at: Date
    updated_at: Date
    invoice_number: string | null
    editable: InvoiceExtraction | null
  }>(
    `SELECT b.id, b.thread_id, b.venue, b.state, b.customer_email, b.customer_name, b.pax,
            b.event_date::text, b.event_start, b.event_end, b.created_at, b.updated_at,
            i.invoice_number, i.editable
       FROM inbox_bookings b
       LEFT JOIN LATERAL (
         SELECT invoice_number, editable FROM inbox_invoices
          WHERE thread_id = b.thread_id AND invoice_number <> 'PENDING'
          ORDER BY id DESC LIMIT 1
       ) i ON TRUE
      WHERE b.created_at > now() - make_interval(days => $1)
      ORDER BY b.created_at DESC
      LIMIT 300`,
    [days]
  )
  return rows.map((r) => {
    const e = r.editable
    return {
      id: r.id,
      status: enquiryStatus(r.state),
      state: r.state,
      venue: r.venue,
      customer_name: e?.customer_name ?? r.customer_name,
      customer_email: e?.customer_email ?? r.customer_email,
      pax: e?.guests ?? r.pax,
      event_date: e?.event_date ?? r.event_date,
      event_start: r.event_start ? new Date(r.event_start).toISOString() : null,
      event_end: r.event_end ? new Date(r.event_end).toISOString() : null,
      event_type: e?.event_type ?? null,
      package_name: e?.package_name ?? null,
      venue_space: e?.venue_space ?? null,
      time_label: e?.time_label ?? null,
      per_person_price: e?.per_person_price ?? null,
      dietaries: e?.dietaries ?? null,
      invoice_number: r.invoice_number,
      gmail_url: `https://mail.google.com/mail/u/0/#all/${r.thread_id}`,
      received_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    }
  })
}

// --- Calendar ---

export interface FnCalendarInput {
  function_id: string
  title: string
  date: string
  start_time?: string // "HH:MM" 24h; all-day when missing
  end_time?: string
  pax?: number
  notes?: string
  status?: "confirmed" | "tbc" | "cancelled"
}

/** Google event ids allow only 0-9 a-v, so hash the app's id. */
export const fnEventId = (functionId: string): string =>
  `fnapp${createHash("sha1").update(functionId).digest("hex")}`

export function fnCalendarEvent(
  i: FnCalendarInput,
  isoDate: string
): { summary: string; description: string; start: object; end: object } {
  const tbc = i.status === "tbc"
  const summary = `${tbc ? "TBC: " : ""}${i.title}${i.pax ? ` (${i.pax} pax)` : ""}`
  const description = [i.notes, "From the Tarte Functions app. Change it there, not here."].filter(Boolean).join("\n\n")
  const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/
  if (i.start_time && hhmm.test(i.start_time)) {
    const pad = (t: string): string => t.padStart(5, "0")
    const start = new Date(`${isoDate}T${pad(i.start_time)}:00+10:00`)
    let end =
      i.end_time && hhmm.test(i.end_time)
        ? new Date(`${isoDate}T${pad(i.end_time)}:00+10:00`)
        : new Date(start.getTime() + 3 * 3600_000)
    if (end <= start) end = new Date(start.getTime() + 3 * 3600_000)
    return {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: "Australia/Brisbane" },
      end: { dateTime: end.toISOString(), timeZone: "Australia/Brisbane" },
    }
  }
  const next = new Date(Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10) + 1))
  return { summary, description, start: { date: isoDate }, end: { date: next.toISOString().slice(0, 10) } }
}

let fnCalendarIdCache: string | undefined

/** The calendar functions are pushed to: FUNCTIONS_CALENDAR_ID when set, else
 * the calendar named FUNCTIONS_CALENDAR_NAME in hello@'s list, else the
 * combined "Tarte Bookings (auto)" calendar the Kitchen functions page reads. */
async function functionsCalendarId(): Promise<string | null> {
  if (fnCalendarIdCache) return fnCalendarIdCache
  const c = config()
  if (c.FUNCTIONS_CALENDAR_ID) return (fnCalendarIdCache = c.FUNCTIONS_CALENDAR_ID)
  const auth = await ensureGoogleAuthed()
  const cal = google.calendar({ version: "v3", auth })
  const list = await cal.calendarList.list({ maxResults: 250 })
  const want = c.FUNCTIONS_CALENDAR_NAME.trim().toLowerCase()
  const hit = (list.data.items ?? []).find(
    (x) =>
      (x.summaryOverride ?? x.summary ?? "").trim().toLowerCase() === want &&
      (x.accessRole === "owner" || x.accessRole === "writer")
  )
  if (hit?.id) return (fnCalendarIdCache = hit.id)
  const combined = await ensureCombinedCalendar()
  return combined ? (fnCalendarIdCache = combined) : null
}

async function pushFunctionToCalendar(
  i: FnCalendarInput
): Promise<{ ok: true; event_id: string; calendar_id: string; removed?: boolean } | { ok: false; error: string }> {
  if (!i.function_id || !i.title) return { ok: false, error: "function_id and title are required" }
  const isoDate = normaliseEventDate(i.date, todayBrisbane())
  if (!isoDate) return { ok: false, error: `couldn't read the date "${i.date}". Send it like 06/12/2026 or 2026-12-06.` }
  const calendarId = await functionsCalendarId()
  if (!calendarId) return { ok: false, error: "no functions calendar hello@ can write to" }
  const auth = await ensureGoogleAuthed()
  const cal = google.calendar({ version: "v3", auth })
  const id = fnEventId(i.function_id)
  if (i.status === "cancelled") {
    await cal.events.delete({ calendarId, eventId: id }).catch(() => {})
    return { ok: true, event_id: id, calendar_id: calendarId, removed: true }
  }
  const body = { ...fnCalendarEvent(i, isoDate), status: "confirmed" }
  try {
    await cal.events.update({ calendarId, eventId: id, requestBody: body })
  } catch {
    await cal.events.insert({ calendarId, requestBody: { id, ...body } })
  }
  return { ok: true, event_id: id, calendar_id: calendarId }
}

// --- HTTP ---

const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""
  return s === "" ? undefined : s
}
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function parseFnFields(b: Record<string, unknown>): FnInvoiceFields {
  const addOns = Array.isArray(b["add_ons"])
    ? (b["add_ons"] as Array<Record<string, unknown>>)
        .map((a) => ({
          description: str(a?.["description"]) ?? "",
          unit_price: num(a?.["unit_price"]) ?? NaN,
          per_person: a?.["per_person"] === true,
        }))
        .filter((a) => a.description && Number.isFinite(a.unit_price))
    : undefined
  return {
    customer_name: str(b["customer_name"]),
    customer_email: str(b["customer_email"]),
    event_type: str(b["event_type"]),
    package_name: str(b["package_name"]),
    venue_space: str(b["venue_space"]),
    event_date: str(b["event_date"]),
    time_label: str(b["time_label"]),
    dietaries: str(b["dietaries"]),
    guests: num(b["guests"]),
    per_person_price: num(b["per_person_price"]),
    deposit_pct: num(b["deposit_pct"]),
    flat_deposit_amount: num(b["flat_deposit_amount"]),
    amount_paid: num(b["amount_paid"]),
    paid_in_full: b["paid_in_full"] === true,
    add_ons: addOns,
  }
}

function keyOk(header: string | undefined): boolean {
  const key = config().FUNCTIONS_API_KEY
  if (!key) return false
  const given = (header ?? "").replace(/^Bearer\s+/i, "").trim()
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const fnApp = new Hono()

fnApp.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = config()
        .FUNCTIONS_APP_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      return allowed.includes(origin) ? origin : null
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 600,
  })
)

// Closed (401) until FUNCTIONS_API_KEY is set, like the invoice portal.
fnApp.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next()
  if (!keyOk(c.req.header("Authorization"))) return c.json({ ok: false, error: "not authorised" }, 401)
  return next()
})

fnApp.onError((e, c) => {
  console.error("[fn] request failed:", e instanceof Error ? e.stack ?? e.message : e)
  return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
})

fnApp.get("/ping", (c) => c.json({ ok: true }))

fnApp.post("/invoice", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const functionId = str(b["function_id"])
  const kind = b["kind"]
  if (!functionId) return c.json({ ok: false, error: "function_id is required" }, 400)
  if (kind !== "deposit" && kind !== "balance")
    return c.json({ ok: false, error: 'kind must be "deposit" or "balance"' }, 400)
  const r = await upsertFunctionInvoice(functionId, kind, parseFnFields(b))
  return c.json(r, r.ok ? 200 : 400)
})

fnApp.get("/invoices", async (c) => {
  const functionId = str(c.req.query("function_id"))
  if (!functionId) return c.json({ ok: false, error: "function_id is required" }, 400)
  return c.json({ ok: true, invoices: (await fnRows(functionId)).map(summariseFnInvoice) })
})

fnApp.get("/invoice/:number/pdf", async (c) => {
  const n = c.req.param("number")
  const { rows } = await db().query<{ pdf_bytes: Buffer | null }>(
    `SELECT pdf_bytes FROM inbox_invoices WHERE invoice_number = $1 AND thread_id LIKE 'fn:%'`,
    [n]
  )
  const bytes = rows[0]?.pdf_bytes
  if (!bytes) return c.json({ ok: false, error: "invoice not found" }, 404)
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${n}.pdf"`,
    "Cache-Control": "no-store",
  })
})

fnApp.post("/invoice/:number/draft-email", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await draftFunctionInvoiceEmail(c.req.param("number"), {
    subject: str(b["subject"]),
    body: str(b["body"]),
  })
  return c.json(r, r.ok ? 200 : 400)
})

fnApp.get("/enquiries", async (c) => {
  const days = Math.min(365, Math.max(1, num(c.req.query("days")) ?? 120))
  return c.json({ ok: true, enquiries: await listEnquiries(days) })
})

fnApp.post("/calendar", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const status = b["status"]
  const r = await pushFunctionToCalendar({
    function_id: str(b["function_id"]) ?? "",
    title: str(b["title"]) ?? "",
    date: str(b["date"]) ?? "",
    start_time: str(b["start_time"]),
    end_time: str(b["end_time"]),
    pax: num(b["pax"]),
    notes: str(b["notes"]),
    status: status === "tbc" || status === "cancelled" ? status : "confirmed",
  })
  return c.json(r, r.ok ? 200 : 400)
})
