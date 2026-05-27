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
  const tenants = (stored.extra?.["tenants"] as Array<{ tenantId: string; tenantName: string }> | undefined) ?? []
  const tarte = tenants.find((t) => /Tarte Currumbin/i.test(t.tenantName))
  const tenant = tarte ?? tenants[0]
  if (!tenant) throw new Error("xero linked but no tenants — re-authorise")
  return { tenantId: tenant.tenantId }
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

export async function createDraftInvoice(opts: {
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
    status: Invoice.StatusEnum.DRAFT,
    lineAmountTypes: LineAmountTypes.Exclusive,
  }
  const r = await xero().accountingApi.createInvoices(tenantId, {
    invoices: [inv],
  })
  const id = r.body.invoices?.[0]?.invoiceID
  if (!id) throw new Error("xero createInvoices returned no id")
  return id
}

export async function getInvoiceOnlineUrl(invoiceId: string): Promise<string | undefined> {
  const { tenantId } = await ensureXeroAuthed()
  const r = await xero().accountingApi.getOnlineInvoice(tenantId, invoiceId)
  return r.body.onlineInvoices?.[0]?.onlineInvoiceUrl ?? undefined
}

/**
 * Fetches the PDF of a Xero invoice (current state — re-fetching after an
 * edit in Xero returns the updated PDF). Returns the raw bytes.
 *
 * Note: PDFs themselves aren't "editable" in the conventional sense. If the
 * team spots a mistake, they should edit the invoice in Xero (it's in DRAFT
 * status), then this function will return the corrected PDF on the next
 * fetch. The Xero invoice URL link in the email also points at the live
 * invoice, so it always reflects current edits.
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
