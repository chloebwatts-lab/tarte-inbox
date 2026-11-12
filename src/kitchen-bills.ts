/**
 * Kitchen DRAFT supplier bills: the narrow Xero door Tarte Kitchen uses
 * (spec: tarte-loose-ends/reference/kitchen-xero-draft-bills-spec.md;
 * Chloe, 12 Nov 2026: "Yes, Kitchen drafts them").
 *
 * Kitchen plans the bills; this endpoint holds the Xero token and makes the
 * calls. It can only:
 *   POST /read    active contacts and recent ACCPAY bills of one org
 *   POST /find    ACCPAY bills of one org with one invoice number
 *   POST /create  ONE bill, which must be ACCPAY + DRAFT, on an existing
 *                 ACTIVE contact, with no InvoiceID (never an update)
 *   POST /attach  a PDF onto one of Kitchen's DRAFT bills with no file yet
 *   POST /attach-existing
 *                 a PDF onto an existing ACCPAY bill (DRAFT, SUBMITTED,
 *                 AUTHORISED or PAID) that has no file yet, only when the
 *                 bill's contact, number and total are exactly what Kitchen
 *                 matched (coordinator 13 Nov 2026: PDFs for hand-keyed bills)
 *   POST /sales   READ ONLY: the org's revenue accounts and its ACCREC
 *                 invoices dated in a window (Kitchen counts event invoices,
 *                 dated the event day, in the wage % revenue; Chloe 12 Nov
 *                 2026: "all revenue ... uber bopple and events from Xero")
 *   GET  /status  whether the attachments grant is in, which orgs are linked
 * Both attach calls need the accounting.attachments grant and only ever PUT
 * one attachment: never a status, amount or contact change.
 * Anything else is refused. It never authorises, pays, voids, deletes or
 * creates a contact.
 *
 * Reached only from the Docker network (http://inbox:8787): a request that
 * came through Caddy (X-Forwarded-For set) is refused, on top of the bearer
 * key (KITCHEN_BILLS_KEY).
 */
import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { config } from "./config.js"
import { getTokens } from "./db/queries.js"
import { xeroTenantAccess } from "./xero/client.js"

const API = "https://api.xero.com/api.xro/2.0"

/** Kitchen's org names to the linked Xero tenants. Nothing else is reachable. */
const ORGS: Record<string, RegExp> = {
  "Tarte Bakery": /^Tarte Bakery$/i,
  "Tarte Currumbin": /^Tarte Currumbin$/i,
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function keyOk(header: string | undefined): boolean {
  const key = config().KITCHEN_BILLS_KEY
  if (!key) return false
  const given = (header ?? "").replace(/^Bearer\s+/i, "").trim()
  const a = Buffer.from(given)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

class XeroCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** true when we cannot know whether Xero acted (network drop, timeout). */
    readonly unknown = false
  ) {
    super(message)
  }
}

/** One Xero call for one org. GETs wait out a minute limit once; writes never retry. */
async function xeroCall(
  org: string,
  method: "GET" | "PUT",
  path: string,
  opts: { json?: unknown; body?: Buffer; contentType?: string; idempotencyKey?: string } = {}
): Promise<unknown> {
  const re = ORGS[org]
  if (!re) throw new XeroCallError(`unknown org ${org}`, 400)
  for (let attempt = 0; attempt < 2; attempt++) {
    const { accessToken, tenantId } = await xeroTenantAccess(re)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: "application/json",
    }
    if (opts.json !== undefined) headers["Content-Type"] = "application/json"
    if (opts.contentType) headers["Content-Type"] = opts.contentType
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
        signal: AbortSignal.timeout(60_000),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[kitchen-bills] ${org} ${method} ${path.split("?")[0] ?? ""} no answer: ${msg}`)
      throw new XeroCallError(`Xero did not answer (${msg})`, 504, method !== "GET")
    }
    const left = res.headers.get("x-daylimit-remaining")
    console.log(`[kitchen-bills] ${org} ${method} ${(path.split("?")[0] ?? "").replace(/[0-9a-f-]{36}/gi, ":id")} ${res.status}${left ? ` day-left=${left}` : ""}`)
    if (res.status === 429) {
      const problem = res.headers.get("x-rate-limit-problem")
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 60), 65)
      if (method === "GET" && problem !== "day" && attempt === 0) {
        await sleep(wait * 1000)
        continue
      }
      throw new XeroCallError(`Xero rate limit (${problem ?? "unknown"}), retry after ${wait}s`, 429)
    }
    const text = await res.text()
    if (!res.ok) throw new XeroCallError(`Xero ${res.status}: ${text.slice(0, 600)}`, res.status)
    return text ? JSON.parse(text) : {}
  }
  throw new XeroCallError("Xero rate limit", 429)
}

const dateOnly = (s: unknown) => (typeof s === "string" ? s.slice(0, 10) : null)

/** The few bill fields Kitchen's planner reads. */
function liteBill(b: Record<string, any>) {
  return {
    InvoiceID: b.InvoiceID,
    Type: b.Type,
    Status: b.Status,
    InvoiceNumber: b.InvoiceNumber ?? "",
    Contact: { ContactID: b.Contact?.ContactID, Name: b.Contact?.Name },
    Date: dateOnly(b.DateString),
    DueDate: dateOnly(b.DueDateString),
    Total: b.Total,
    Url: b.Url ?? undefined,
    HasAttachments: b.HasAttachments === true,
    LineItems: (b.LineItems ?? []).map((l: Record<string, any>) => ({
      AccountCode: l.AccountCode,
      TaxType: l.TaxType,
      LineAmount: l.LineAmount,
      Tracking: (l.Tracking ?? []).map((t: Record<string, any>) => ({ Name: t.Name, Option: t.Option })),
    })),
  }
}

const whereQ = (w: string) => `where=${encodeURIComponent(w)}`

async function readOrg(org: string, since: string) {
  const [y, m, d] = since.split("-").map(Number)
  const contacts: { ContactID: string; Name: string }[] = []
  for (let page = 1; page <= 20; page++) {
    const j = (await xeroCall(org, "GET", `/Contacts?${whereQ('ContactStatus=="ACTIVE"')}&summaryOnly=true&page=${page}&pageSize=1000`)) as { Contacts?: any[] }
    const rows = j.Contacts ?? []
    contacts.push(...rows.map((c) => ({ ContactID: c.ContactID, Name: c.Name })))
    if (rows.length < 1000) break
    await sleep(1100)
  }
  const bills: ReturnType<typeof liteBill>[] = []
  for (let page = 1; page <= 40; page++) {
    const j = (await xeroCall(org, "GET", `/Invoices?${whereQ(`Type=="ACCPAY" AND Date>=DateTime(${y},${m},${d})`)}&order=Date&page=${page}&pageSize=500`)) as { Invoices?: any[] }
    const rows = j.Invoices ?? []
    bills.push(...rows.map(liteBill))
    if (rows.length < 500) break
    await sleep(1100)
  }
  return { contacts, bills }
}

/** The few sales-invoice fields Kitchen's event-revenue count reads. */
export function liteSale(s: Record<string, any>) {
  return {
    InvoiceID: s.InvoiceID,
    Status: s.Status,
    InvoiceNumber: s.InvoiceNumber ?? "",
    Reference: s.Reference ?? "",
    Contact: { Name: s.Contact?.Name ?? "" },
    Date: dateOnly(s.DateString),
    LineAmountTypes: s.LineAmountTypes,
    Total: s.Total,
    LineItems: (s.LineItems ?? []).map((l: Record<string, any>) => ({
      Description: l.Description ?? "",
      AccountCode: l.AccountCode ?? "",
      LineAmount: l.LineAmount ?? 0,
      TaxAmount: l.TaxAmount ?? 0,
      Tracking: (l.Tracking ?? []).map((t: Record<string, any>) => ({ Name: t.Name, Option: t.Option })),
    })),
  }
}

/** Revenue accounts per org, cached: the chart barely changes and Xero's
 * daily call allowance is shared with the CBK scripts and the bill drafts. */
const accountsCache = new Map<string, { at: number; rows: { Code: string; Name: string; Type: string }[] }>()
const ACCOUNTS_TTL_MS = 6 * 60 * 60 * 1000

async function revenueAccounts(org: string) {
  const hit = accountsCache.get(org)
  if (hit && Date.now() - hit.at < ACCOUNTS_TTL_MS) return hit.rows
  const j = (await xeroCall(org, "GET", `/Accounts?${whereQ('Class=="REVENUE"')}`)) as { Accounts?: any[] }
  const rows = (j.Accounts ?? []).filter((a) => a.Code).map((a) => ({ Code: String(a.Code), Name: String(a.Name ?? ""), Type: String(a.Type ?? "") }))
  accountsCache.set(org, { at: Date.now(), rows })
  return rows
}

/** ACCREC invoices dated in [from, to), live statuses only (voided and
 * deleted ones are not revenue). Paged so Xero returns the line items. */
async function readSales(org: string, from: string, to: string) {
  const [fy, fm, fd] = from.split("-").map(Number)
  const [ty, tm, td] = to.split("-").map(Number)
  const where = `Type=="ACCREC" AND Date>=DateTime(${fy},${fm},${fd}) AND Date<DateTime(${ty},${tm},${td})`
  const invoices: ReturnType<typeof liteSale>[] = []
  for (let page = 1; page <= 20; page++) {
    const j = (await xeroCall(org, "GET", `/Invoices?${whereQ(where)}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID&order=Date&page=${page}&pageSize=500`)) as { Invoices?: any[] }
    const rows = j.Invoices ?? []
    invoices.push(...rows.map(liteSale))
    if (rows.length < 500) break
    await sleep(1100)
  }
  return { accounts: await revenueAccounts(org), invoices }
}

async function findByNumber(org: string, invoiceNumber: string) {
  const j = (await xeroCall(org, "GET", `/Invoices?${whereQ(`Type=="ACCPAY" AND InvoiceNumber=="${invoiceNumber}"`)}`)) as { Invoices?: any[] }
  return (j.Invoices ?? []).map(liteBill)
}

const BILL_KEYS = new Set(["Type", "Status", "Contact", "Date", "DueDate", "InvoiceNumber", "Reference", "Url", "LineAmountTypes", "LineItems"])
const LINE_KEYS = new Set(["Description", "Quantity", "UnitAmount", "AccountCode", "TaxType", "TaxAmount", "Tracking"])
const YMD = /^\d{4}-\d{2}-\d{2}$/

/** Why this body is not a plain DRAFT bill on a contact id, or null when it is. */
export function refuseBill(b: unknown): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "bill must be an object"
  const bill = b as Record<string, any>
  for (const k of Object.keys(bill)) if (!BILL_KEYS.has(k)) return `field ${k} is not allowed`
  if (bill.Type !== "ACCPAY") return "Type must be ACCPAY"
  if (bill.Status !== "DRAFT") return "Status must be DRAFT"
  if (!bill.Contact || typeof bill.Contact !== "object" || Object.keys(bill.Contact).join() !== "ContactID" || !GUID.test(bill.Contact.ContactID))
    return "Contact must be { ContactID } of an existing contact"
  if (!YMD.test(bill.Date ?? "") || !YMD.test(bill.DueDate ?? "")) return "Date and DueDate must be yyyy-mm-dd"
  if (typeof bill.InvoiceNumber !== "string" || !bill.InvoiceNumber.trim() || /["\\]/.test(bill.InvoiceNumber) || bill.InvoiceNumber.length > 255)
    return "InvoiceNumber must be plain text"
  if (bill.LineAmountTypes !== "Exclusive") return "LineAmountTypes must be Exclusive"
  if (!Array.isArray(bill.LineItems) || bill.LineItems.length < 1 || bill.LineItems.length > 2) return "one or two lines"
  for (const l of bill.LineItems) {
    if (!l || typeof l !== "object") return "line must be an object"
    for (const k of Object.keys(l)) if (!LINE_KEYS.has(k)) return `line field ${k} is not allowed`
    if (l.Quantity !== 1 || typeof l.UnitAmount !== "number" || !(l.UnitAmount > 0)) return "lines are quantity 1 with a positive amount"
    if (typeof l.AccountCode !== "string" || typeof l.TaxType !== "string" || typeof l.TaxAmount !== "number") return "lines need AccountCode, TaxType and TaxAmount"
  }
  return null
}

export const kitchenBillsApp = new Hono()

kitchenBillsApp.use("*", async (c, next) => {
  if (c.req.header("x-forwarded-for") || c.req.header("x-forwarded-host")) return c.json({ ok: false, error: "internal only" }, 403)
  if (!keyOk(c.req.header("authorization"))) return c.json({ ok: false, error: "unauthorised" }, 401)
  await next()
})

function fail(c: any, e: unknown) {
  if (e instanceof XeroCallError) return c.json({ ok: false, error: e.message, unknown: e.unknown }, e.status >= 400 && e.status < 600 ? e.status : 502)
  return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
}

kitchenBillsApp.get("/status", async (c) => {
  const stored = await getTokens("xero")
  const scopes = (stored?.scope ?? "").split(/\s+/)
  const tenants = ((stored?.extra?.["tenants"] as Array<{ tenantName: string }> | undefined) ?? []).map((t) => t.tenantName)
  return c.json({ ok: true, attachments: scopes.includes("accounting.attachments"), orgs: Object.entries(ORGS).filter(([, re]) => tenants.some((t) => re.test(t))).map(([o]) => o) })
})

kitchenBillsApp.post("/read", async (c) => {
  const { org, since } = (await c.req.json().catch(() => ({}))) as { org?: string; since?: string }
  if (!org || !ORGS[org] || !YMD.test(since ?? "")) return c.json({ ok: false, error: "org and since (yyyy-mm-dd) required" }, 400)
  try {
    return c.json({ ok: true, ...(await readOrg(org, since!)) })
  } catch (e) {
    return fail(c, e)
  }
})

kitchenBillsApp.post("/sales", async (c) => {
  const { org, from, to } = (await c.req.json().catch(() => ({}))) as { org?: string; from?: string; to?: string }
  if (!org || !ORGS[org] || !YMD.test(from ?? "") || !YMD.test(to ?? "") || from! >= to!)
    return c.json({ ok: false, error: "org, from and to (yyyy-mm-dd, from before to) required" }, 400)
  // At most about 13 weeks back: enough for Kitchen's 45-day feed, small enough to stay one page.
  if (Date.parse(to!) - Date.parse(from!) > 92 * 86400_000) return c.json({ ok: false, error: "window is 92 days at most" }, 400)
  try {
    return c.json({ ok: true, ...(await readSales(org, from!, to!)) })
  } catch (e) {
    return fail(c, e)
  }
})

kitchenBillsApp.post("/find", async (c) => {
  const { org, invoiceNumber } = (await c.req.json().catch(() => ({}))) as { org?: string; invoiceNumber?: string }
  if (!org || !ORGS[org] || typeof invoiceNumber !== "string" || !invoiceNumber.trim() || /["\\]/.test(invoiceNumber))
    return c.json({ ok: false, error: "org and a plain invoiceNumber required" }, 400)
  try {
    return c.json({ ok: true, bills: await findByNumber(org, invoiceNumber.trim()) })
  } catch (e) {
    return fail(c, e)
  }
})

kitchenBillsApp.post("/create", async (c) => {
  const { org, bill, idempotencyKey } = (await c.req.json().catch(() => ({}))) as { org?: string; bill?: unknown; idempotencyKey?: string }
  if (!org || !ORGS[org]) return c.json({ ok: false, error: "org required" }, 400)
  const why = refuseBill(bill)
  if (why) return c.json({ ok: false, error: `refused: ${why}` }, 400)
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) return c.json({ ok: false, error: "idempotencyKey required" }, 400)
  const b = bill as Record<string, any>
  try {
    // The contact must exist and be active: never a new one.
    const cj = (await xeroCall(org, "GET", `/Contacts/${b.Contact.ContactID}`)) as { Contacts?: { ContactStatus?: string }[] }
    if (cj.Contacts?.[0]?.ContactStatus !== "ACTIVE") return c.json({ ok: false, error: "refused: contact is not an active contact in this org" }, 409)
    // Same contact and number already in this org, any status: never twice.
    const same = (await findByNumber(org, b.InvoiceNumber.trim())).filter((x) => x.Contact.ContactID === b.Contact.ContactID)
    if (same.length) return c.json({ ok: false, error: "refused: already in Xero", existing: same }, 409)
    const j = (await xeroCall(org, "PUT", "/Invoices?summarizeErrors=false", { json: { Invoices: [b] }, idempotencyKey })) as { Invoices?: any[] }
    const got = j.Invoices?.[0]
    if (!got?.InvoiceID || got.HasErrors || (got.ValidationErrors ?? []).length)
      return c.json({ ok: false, error: `Xero did not create it: ${JSON.stringify(got?.ValidationErrors ?? got ?? j).slice(0, 600)}` }, 422)
    if (got.Status !== "DRAFT") console.error(`[kitchen-bills] ${org} created ${got.InvoiceID} as ${got.Status}, expected DRAFT`)
    return c.json({ ok: true, bill: liteBill(got) })
  } catch (e) {
    return fail(c, e)
  }
})

/** Statuses a PDF may be added to on an existing bill (never VOIDED or DELETED). */
const ATTACHABLE = new Set(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID"])

export interface AttachExpect {
  contactId: string
  invoiceNumber: string
  total: number
}

/**
 * Why a PDF must not go onto this bill, or null when it may. `expect` is what
 * Kitchen matched (contact, number and total, all exact); `draftOnly` is the
 * nightly path, which only ever attaches to the draft it has just created.
 */
export function refuseAttach(inv: Record<string, any> | undefined, opts: { draftOnly: boolean; expect?: AttachExpect }): string | null {
  if (!inv?.InvoiceID) return "no such bill in this org"
  if (inv.Type !== "ACCPAY") return "not a bill (ACCPAY)"
  if (opts.draftOnly ? inv.Status !== "DRAFT" : !ATTACHABLE.has(inv.Status)) return `bill is ${inv.Status}`
  if (inv.HasAttachments === true) return "bill already has a file attached"
  const e = opts.expect
  if (e) {
    if (inv.Contact?.ContactID !== e.contactId) return "contact is not the one matched"
    if ((inv.InvoiceNumber ?? "") !== e.invoiceNumber) return "invoice number is not the one matched"
    if (typeof inv.Total !== "number" || Math.round(inv.Total * 100) !== Math.round(e.total * 100)) return "total is not the one matched"
  }
  return null
}

/** Shared by both attach calls: the grant, a real PDF, the bill checks, one PUT. */
async function attachOne(c: any, opts: { draftOnly: boolean }) {
  const { org, invoiceId, filename, contentBase64, expect } = (await c.req.json().catch(() => ({}))) as {
    org?: string
    invoiceId?: string
    filename?: string
    contentBase64?: string
    expect?: AttachExpect
  }
  if (!org || !ORGS[org] || !GUID.test(invoiceId ?? "") || !/^[A-Za-z0-9 ._-]{1,120}\.pdf$/i.test(filename ?? "") || !contentBase64)
    return c.json({ ok: false, error: "org, invoiceId, filename (.pdf) and contentBase64 required" }, 400)
  if (
    !opts.draftOnly &&
    (!expect || !GUID.test(expect.contactId ?? "") || typeof expect.invoiceNumber !== "string" || !expect.invoiceNumber.trim() || typeof expect.total !== "number" || !Number.isFinite(expect.total))
  )
    return c.json({ ok: false, error: "expect { contactId, invoiceNumber, total } required" }, 400)
  const stored = await getTokens("xero")
  if (!(stored?.scope ?? "").split(/\s+/).includes("accounting.attachments"))
    return c.json({ ok: false, reason: "scope", error: "Xero has not granted accounting.attachments yet (one re-consent at /oauth/xero/start)" }, 200)
  const body = Buffer.from(contentBase64, "base64")
  if (!body.length || body.length > 10 * 1024 * 1024) return c.json({ ok: false, error: "PDF must be under 10 MB" }, 400)
  if (body.subarray(0, 5).toString("latin1") !== "%PDF-") return c.json({ ok: false, error: "not a PDF" }, 400)
  try {
    const j = (await xeroCall(org, "GET", `/Invoices/${invoiceId}`)) as { Invoices?: Record<string, any>[] }
    const why = refuseAttach(j.Invoices?.[0], { draftOnly: opts.draftOnly, expect: opts.draftOnly ? undefined : expect })
    if (why) return c.json({ ok: false, refused: true, error: `refused: ${why}` }, 409)
    await xeroCall(org, "PUT", `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(filename!)}`, { body, contentType: "application/pdf" })
    return c.json({ ok: true })
  } catch (e) {
    return fail(c, e)
  }
}

kitchenBillsApp.post("/attach", (c) => attachOne(c, { draftOnly: true }))
kitchenBillsApp.post("/attach-existing", (c) => attachOne(c, { draftOnly: false }))
