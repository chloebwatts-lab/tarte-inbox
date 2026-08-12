import { XeroClient, Invoice, LineAmountTypes, type Contact } from "xero-node"
import { config } from "../config.js"
import { getTokens, saveTokens } from "../db/queries.js"

let client: XeroClient | undefined

export function xero(): XeroClient {
  if (client) return client
  const c = config()
  client = new XeroClient({
    clientId: c.XERO_CLIENT_ID,
    clientSecret: c.XERO_CLIENT_SECRET,
    redirectUris: [c.XERO_REDIRECT_URI],
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      // New granular scopes (apps created after 2026-03-02 don't have the
      // legacy `accounting.transactions` broad scope).
      "accounting.contacts",
      "accounting.invoices",
      "accounting.settings.read",
      // Read bank transactions to verify a deposit landed (re-auth needed once
      // after adding this — until then xeroBankMatchReady() is false).
      // Granular-model name: the legacy "accounting.transactions.read" is
      // REJECTED by this app with invalid_scope (verified 2026-07-27 by
      // probing the authorize endpoint).
      "accounting.banktransactions.read",
    ],
  })
  return client
}

export async function xeroAuthUrl(): Promise<string> {
  return xero().buildConsentUrl()
}

export async function exchangeXeroCallback(fullUrl: string): Promise<void> {
  const tokenSet = await xero().apiCallback(fullUrl)
  await xero().updateTenants(false)
  const tenants = xero().tenants
  await saveTokens({
    provider: "xero",
    access_token: tokenSet.access_token ?? "",
    refresh_token: tokenSet.refresh_token ?? null,
    scope: tokenSet.scope ?? null,
    token_type: tokenSet.token_type ?? null,
    expiry: tokenSet.expires_at ? new Date(tokenSet.expires_at * 1000) : null,
    extra: { tenants },
  })
}

async function ensureXeroAuthed(): Promise<{ tenantId: string }> {
  const stored = await getTokens("xero")
  if (!stored) throw new Error("xero not linked — visit /oauth/xero/start")
  const c = xero()
  // initialize() builds the underlying openid client — without it,
  // refreshToken() crashes ("reading 'refresh' of undefined"). Idempotent.
  await c.initialize()
  c.setTokenSet({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    scope: stored.scope ?? undefined,
    token_type: stored.token_type ?? undefined,
    expires_at: stored.expiry ? Math.floor(stored.expiry.getTime() / 1000) : undefined,
  })
  // Refresh if expired (xero-node handles internally on next call, but be explicit).
  if (stored.expiry && stored.expiry.getTime() < Date.now() + 60_000) {
    const refreshed = await c.refreshToken()
    await saveTokens({
      provider: "xero",
      access_token: refreshed.access_token ?? "",
      refresh_token: refreshed.refresh_token ?? null,
      scope: refreshed.scope ?? null,
      token_type: refreshed.token_type ?? null,
      expiry: refreshed.expires_at ? new Date(refreshed.expires_at * 1000) : null,
    })
  }
  let tenants = (stored.extra?.["tenants"] as Array<{ tenantId: string; tenantName: string }> | undefined) ?? []
  if (!tenants.length) {
    // Tenants got wiped (a past token-refresh bug overwrote extra). They can
    // be refetched with the live token — self-heal instead of forcing re-auth.
    try {
      await c.updateTenants(false)
      tenants = (c.tenants as Array<{ tenantId: string; tenantName: string }>) ?? []
      if (tenants.length) {
        await saveTokens({
          provider: "xero",
          access_token: stored.access_token,
          extra: { tenants },
        })
        console.log(`[xero] recovered ${tenants.length} tenant(s) via updateTenants`)
      }
    } catch (e) {
      console.error("[xero] tenant recovery failed:", e instanceof Error ? e.message : e)
    }
  }
  const tarte = tenants.find((t) => /Tarte Currumbin/i.test(t.tenantName))
  const tenant = tarte ?? tenants[0]
  if (!tenant) throw new Error("xero linked but no tenants — re-authorise")
  return { tenantId: tenant.tenantId }
}

/**
 * Daily keepalive: Xero refresh tokens die after 60 idle days, and invoices
 * can easily go quiet for longer than that. Refreshing daily keeps the
 * rotating refresh token warm so the next invoice never hits a dead link.
 */
export async function xeroKeepalive(): Promise<void> {
  // Reports into the watchdog so a broken Xero link ALERTS instead of just
  // logging (the July tenant-wipe incident sat unnoticed in these logs).
  const { setCheckStatus } = await import("../health.js")
  try {
    await ensureXeroAuthed()
    await setCheckStatus("xero_api", true).catch(() => {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[xero] keepalive failed — re-link at /oauth/xero/start:", msg)
    await setCheckStatus("xero_api", false, `Daily Xero connectivity check failed: ${msg}`).catch(() => {})
  }
}

export async function findOrCreateContact(
  email: string,
  name: string
): Promise<string> {
  const { tenantId } = await ensureXeroAuthed()
  const where = `EmailAddress="${email.replace(/"/g, '\\"')}"`
  const existing = await xero().accountingApi.getContacts(
    tenantId,
    undefined,
    where
  )
  const found = existing.body.contacts?.[0]
  if (found?.contactID) return found.contactID
  const created = await xero().accountingApi.createContacts(tenantId, {
    contacts: [{ name, emailAddress: email } as Contact],
  })
  const id = created.body.contacts?.[0]?.contactID
  if (!id) throw new Error("xero createContacts returned no id")
  return id
}

export interface InvoiceLine {
  description: string
  quantity: number
  unitAmount: number
  accountCode?: string
}

/**
 * Creates an AUTHORISED invoice (Chris 2026-06-12: no DRAFT-in-Xero approval
 * step — the human gate is the email review instead; the invoice PDF is
 * attached to the customer email). Authorised invoices can still be voided
 * in Xero while unpaid, and the online payment link only works once
 * authorised anyway.
 */
export async function createAuthorisedInvoice(opts: {
  contactId: string
  reference: string
  dueDate?: Date
  lines: InvoiceLine[]
}): Promise<string> {
  const { tenantId } = await ensureXeroAuthed()
  const inv: Invoice = {
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: opts.contactId },
    reference: opts.reference,
    date: new Date().toISOString().slice(0, 10),
    dueDate: (opts.dueDate ?? new Date(Date.now() + 7 * 86400_000))
      .toISOString()
      .slice(0, 10),
    lineItems: opts.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      accountCode: l.accountCode ?? "200",
    })),
    status: Invoice.StatusEnum.AUTHORISED,
    lineAmountTypes: LineAmountTypes.Exclusive,
  }
  const r = await xero().accountingApi.createInvoices(tenantId, {
    invoices: [inv],
  })
  const id = r.body.invoices?.[0]?.invoiceID
  if (!id) throw new Error("xero createInvoices returned no id")
  return id
}

/** Whether the stored Xero token can read bank transactions yet. False until
 * Chris re-authorises after the accounting.transactions.read scope was added. */
/**
 * DRAFT Xero invoice dated the EVENT DATE — Matt's rule via Chloe
 * (2026-07-28): event revenue must land against the event date, not the
 * invoice date or the day the deposit arrives. Kept as DRAFT so Louise
 * reviews, recodes if needed, approves, and applies the deposit + balance
 * bank payments against it. One Xero invoice per event (the deposit and
 * balance PDFs share it), upserted on every rebuild so guest-count changes
 * flow through. Amounts are GST-INCLUSIVE (matches the PDF pricing).
 */
export interface EventDraftResult {
  invoiceId: string
  /** false when the Xero invoice is past DRAFT (approved/paid) and was left
   * untouched — the caller must tell Louise to adjust it by hand. */
  updated: boolean
  skippedReason?: string
}

/** Revenue account for event lines. The Currumbin chart is custom, so "200"
 * (Xero's stock Sales code) may not exist — resolve the real "Event Sales"
 * account once and cache it for the process lifetime. */
let eventSalesCode: string | null = null
export async function resolveEventSalesAccountCode(): Promise<string> {
  if (eventSalesCode) return eventSalesCode
  const { tenantId } = await ensureXeroAuthed()
  // Class covers SALES + REVENUE + OTHERINCOME typed accounts — the Currumbin
  // chart's income accounts are custom, so don't gamble on the narrower Type.
  const r = await xero().accountingApi.getAccounts(tenantId, undefined, 'Class=="REVENUE"')
  const accounts = (r.body.accounts ?? []).filter((a) => a.code)
  const byName = (re: RegExp) => accounts.find((a) => re.test(a.name ?? ""))
  const pick =
    byName(/^event sales$/i) ??
    byName(/event/i) ??
    accounts.find((a) => a.code === "200") ??
    accounts[0]
  if (!pick?.code) throw new Error("xero: no revenue account found for event invoices")
  eventSalesCode = pick.code
  console.log(`[xero] event lines will use revenue account ${pick.code} (${pick.name})`)
  return eventSalesCode
}

/** Standalone cake / goods orders go to Matt's 44097 "Sales - Online" (same
 * account as the Stripe website cakes) rather than Event Sales. Verified at
 * runtime; falls back to the event account if 44097 ever disappears. */
let onlineSalesCode: string | null = null
export async function resolveOnlineSalesAccountCode(): Promise<string> {
  if (onlineSalesCode) return onlineSalesCode
  const { tenantId } = await ensureXeroAuthed()
  const r = await xero().accountingApi.getAccounts(tenantId, undefined, 'Class=="REVENUE"')
  const accounts = (r.body.accounts ?? []).filter((a) => a.code)
  const pick =
    accounts.find((a) => a.code === "44097") ??
    accounts.find((a) => /sales\s*-?\s*online|online\s*sales/i.test(a.name ?? ""))
  if (!pick?.code) {
    console.warn("[xero] 44097 Sales - Online not found — cake orders will use the event account")
    return resolveEventSalesAccountCode()
  }
  onlineSalesCode = pick.code
  console.log(`[xero] cake/goods lines will use revenue account ${pick.code} (${pick.name})`)
  return onlineSalesCode
}

async function getInvoiceSnapshot(
  tenantId: string,
  invoiceId: string
): Promise<{ status: string; amountPaid: number; amountCredited: number }> {
  const r = await xero().accountingApi.getInvoice(tenantId, invoiceId)
  const inv = r.body.invoices?.[0]
  return {
    status: String(inv?.status ?? "UNKNOWN"),
    amountPaid: inv?.amountPaid ?? 0,
    amountCredited: inv?.amountCredited ?? 0,
  }
}

export async function upsertEventDraftInvoice(opts: {
  existingInvoiceId?: string | null
  contactId: string
  reference: string
  eventDate: string // YYYY-MM-DD — becomes the invoice date AND due date
  lines: InvoiceLine[]
  // Our TARTE-YYYY-NNNNN number, set as the Xero invoice number so the
  // numbers staff see in email match what Matt finds in Xero (his 2026-07-31
  // gripe: "the invoice numbers in your email are not in Xero"). Xero mints
  // its own INV-00xx when this is omitted.
  invoiceNumber?: string
}): Promise<EventDraftResult> {
  const { tenantId } = await ensureXeroAuthed()
  const accountCode = await resolveEventSalesAccountCode()
  const inv: Invoice = {
    type: Invoice.TypeEnum.ACCREC,
    contact: { contactID: opts.contactId },
    reference: opts.reference,
    ...(opts.invoiceNumber ? { invoiceNumber: opts.invoiceNumber } : {}),
    date: opts.eventDate,
    dueDate: opts.eventDate,
    lineItems: opts.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitAmount: l.unitAmount,
      accountCode: l.accountCode ?? accountCode,
    })),
    status: Invoice.StatusEnum.DRAFT,
    lineAmountTypes: LineAmountTypes.Inclusive,
  }
  if (opts.existingInvoiceId) {
    // Never rewrite an invoice Louise has already approved or applied money
    // to — updating those (or demoting them to DRAFT) either errors or
    // silently changes reviewed books. Skip and let the caller notify.
    const snap = await getInvoiceSnapshot(tenantId, opts.existingInvoiceId)
    if (snap.status !== "DRAFT") {
      return {
        invoiceId: opts.existingInvoiceId,
        updated: false,
        skippedReason: `Xero invoice is ${snap.status}${
          snap.amountPaid ? ` with $${snap.amountPaid.toFixed(2)} applied` : ""
        } — update it manually`,
      }
    }
    const r = await xero().accountingApi.updateInvoice(tenantId, opts.existingInvoiceId, {
      invoices: [inv],
    })
    return { invoiceId: r.body.invoices?.[0]?.invoiceID ?? opts.existingInvoiceId, updated: true }
  }
  const r = await xero().accountingApi.createInvoices(tenantId, { invoices: [inv] })
  const id = r.body.invoices?.[0]?.invoiceID
  if (!id) throw new Error("xero createInvoices returned no id")
  return { invoiceId: id, updated: true }
}

export interface CancelInvoiceResult {
  action: "deleted" | "voided" | "manual"
  status: string
  amountPaid: number
}

/** Cancel the Xero side of a cancelled event. DRAFT → DELETED, approved but
 * unpaid → VOIDED, anything with money applied is left alone (action:
 * "manual") so Louise decides refund vs forfeit with the prepayment. */
export async function cancelEventInvoice(invoiceId: string): Promise<CancelInvoiceResult> {
  const { tenantId } = await ensureXeroAuthed()
  const snap = await getInvoiceSnapshot(tenantId, invoiceId)
  const setStatus = async (status: Invoice.StatusEnum) => {
    await xero().accountingApi.updateInvoice(tenantId, invoiceId, {
      invoices: [{ status } as Invoice],
    })
  }
  if (snap.status === "DRAFT" || snap.status === "SUBMITTED") {
    await setStatus(Invoice.StatusEnum.DELETED)
    return { action: "deleted", status: snap.status, amountPaid: snap.amountPaid }
  }
  if (snap.status === "AUTHORISED" && snap.amountPaid === 0 && snap.amountCredited === 0) {
    await setStatus(Invoice.StatusEnum.VOIDED)
    return { action: "voided", status: snap.status, amountPaid: snap.amountPaid }
  }
  return { action: "manual", status: snap.status, amountPaid: snap.amountPaid }
}

export async function xeroBankMatchReady(): Promise<boolean> {
  const stored = await getTokens("xero")
  return Boolean(
    stored?.scope
      ?.split(/\s+/)
      .some((s) => /accounting\.(bank)?transactions(\.read)?$/.test(s))
  )
}

export interface MatchedPayment {
  bankTransactionId: string
  total: number
  reference: string
  date: string
  contactName: string
}

/** All incoming (RECEIVE) bank transactions in the window — one fetch that
 * callers match locally (the daily event-payments digest does one pull
 * instead of a Xero call per expected amount). Reconciled txns only. */
export async function listIncomingBankTransactions(sinceDays = 90): Promise<MatchedPayment[]> {
  const { tenantId } = await ensureXeroAuthed()
  const since = new Date(Date.now() - sinceDays * 86400_000)
  const where = `Type=="RECEIVE" AND Date>=DateTime(${since.getUTCFullYear()},${since.getUTCMonth() + 1},${since.getUTCDate()})`
  const r = await xero().accountingApi.getBankTransactions(tenantId, undefined, where, "Date DESC")
  return (r.body.bankTransactions ?? []).map((t) => ({
    bankTransactionId: t.bankTransactionID ?? "",
    total: typeof t.total === "number" ? t.total : Number(t.total ?? 0),
    reference: t.reference ?? "",
    // The SDK hands back JS Date objects — normalise to ISO so callers can
    // slice/compare dates without "Invalid Date" surprises.
    date: t.date ? new Date(t.date as unknown as string | Date).toISOString() : "",
    contactName: t.contact?.name ?? "",
  }))
}

/**
 * Look for an incoming (RECEIVE) bank transaction that matches a deposit: the
 * amount must equal `amount`, and either the reference contains the invoice
 * reference or the payer name matches the customer. Best-effort — relies on the
 * bank feed being reconciled and (ideally) the customer using the invoice
 * number as their transfer reference. Returns the best match or null.
 *
 * NOTE: getBankTransactions only returns reconciled/created bank transactions,
 * not raw unreconciled statement lines, so a just-arrived payment may not show
 * until it's reconciled in Xero.
 */
export async function findIncomingPayment(opts: {
  amount: number
  reference?: string | null
  customerName?: string | null
  sinceDays?: number
}): Promise<MatchedPayment | null> {
  const { tenantId } = await ensureXeroAuthed()
  const since = new Date(Date.now() - (opts.sinceDays ?? 45) * 86400_000)
  const where =
    `Type=="RECEIVE" AND Date>=DateTime(${since.getUTCFullYear()},${since.getUTCMonth() + 1},${since.getUTCDate()})`
  const r = await xero().accountingApi.getBankTransactions(tenantId, undefined, where, "Date DESC")
  const txns = r.body.bankTransactions ?? []
  const ref = opts.reference?.toLowerCase().trim()
  const name = opts.customerName?.toLowerCase().trim()
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01
  let fallback: MatchedPayment | null = null
  for (const t of txns) {
    const total = typeof t.total === "number" ? t.total : Number(t.total ?? 0)
    if (!near(total, opts.amount)) continue
    const tRef = (t.reference ?? "").toLowerCase()
    const tName = (t.contact?.name ?? "").toLowerCase()
    const m: MatchedPayment = {
      bankTransactionId: t.bankTransactionID ?? "",
      total,
      reference: t.reference ?? "",
      date: t.date ?? "",
      contactName: t.contact?.name ?? "",
    }
    // Strong match: amount + reference (or payer name) line up.
    if ((ref && tRef.includes(ref)) || (name && tName.includes(name))) return m
    // Weak match: amount alone — remember it but keep looking for a stronger one.
    fallback ??= m
  }
  return fallback
}

export async function getInvoiceOnlineUrl(invoiceId: string): Promise<string | undefined> {
  const { tenantId } = await ensureXeroAuthed()
  const r = await xero().accountingApi.getOnlineInvoice(tenantId, invoiceId)
  return r.body.onlineInvoices?.[0]?.onlineInvoiceUrl ?? undefined
}

/**
 * Fetches the PDF of a Xero invoice (current state — re-fetching after an
 * edit in Xero returns the updated PDF). Returns the raw bytes. If the team
 * spots a mistake, void the invoice in Xero and re-issue; the online link in
 * the email always reflects the live invoice.
 */
export async function getInvoicePdf(invoiceId: string): Promise<Buffer> {
  const { tenantId } = await ensureXeroAuthed()
  const r = await xero().accountingApi.getInvoiceAsPdf(tenantId, invoiceId, {
    headers: { Accept: "application/pdf" },
  })
  // The xero-node SDK returns the PDF as a ReadStream in `body`.
  const stream = r.body as unknown as NodeJS.ReadableStream
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
