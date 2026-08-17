// Read-only audit: where has the money for the function invoices gone?
//
// Four event invoices were sitting AUTHORISED with $0.00 applied (Janine Reed,
// Tamika Plumb, Abrianna Daniel, Jenna Strauch — $6,914 total as at 17 Aug
// 2026) even though all four bookings took a deposit. This lists every TARTE
// invoice with its true status (the Xero MCP connector hides DRAFTs), every
// unapplied prepayment / overpayment / credit note, and every incoming bank
// receipt that isn't a POS settlement, so the deposits can be traced.
//
//   docker compose exec inbox node dist/scripts/find-event-deposits.js
//
// Writes nothing except the rotated Xero refresh token (unavoidable, same as
// test-xero.js). Never console.error a xero-node error wholesale — they carry
// the raw Bearer token.

import { xero } from "../xero/client.js"
import { getTokens, saveTokens } from "../db/queries.js"

const SINCE = "2026-06-01"
/** Contacts that are POS/settlement plumbing, not function customers. */
const NOISE = /tarte (beach house|market|currumbin)|square|lightspeed|stripe|tyro/i

function money(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function fmt(n: number): string {
  return `$${n.toFixed(2)}`
}

/**
 * xero-node rejects with a plain object whose `request.headers.authorization`
 * holds the live Bearer token, and it is NOT an Error, so `String(e)` prints
 * the token. Never stringify the value — pull out named fields only.
 */
function safeErr(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  const r = (e as { response?: { statusCode?: number; body?: { Detail?: string } } })?.response
  if (r?.statusCode) {
    const scope = r.statusCode === 401 ? " — the app's Xero scopes don't cover this endpoint" : ""
    return `HTTP ${r.statusCode}${r.body?.Detail ? ` (${r.body.Detail})` : ""}${scope}`
  }
  return "unknown error (details suppressed: xero-node errors embed the bearer token)"
}

function dateOf(v: unknown): string {
  if (!v) return "?"
  const s = String(v)
  return s.slice(0, 10)
}

async function main(): Promise<void> {
  const stored = await getTokens("xero")
  if (!stored) throw new Error("xero not linked")
  const c = xero()
  await c.initialize()
  c.setTokenSet({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    scope: stored.scope ?? undefined,
    token_type: stored.token_type ?? undefined,
    expires_at: stored.expiry ? Math.floor(stored.expiry.getTime() / 1000) : undefined,
  })
  const refreshed = await c.refreshToken()
  await saveTokens({
    provider: "xero",
    access_token: refreshed.access_token ?? "",
    refresh_token: refreshed.refresh_token ?? null,
    scope: refreshed.scope ?? null,
    token_type: refreshed.token_type ?? null,
    expiry: refreshed.expires_at ? new Date(refreshed.expires_at * 1000) : null,
  })
  const tenants =
    (stored.extra?.["tenants"] as Array<{ tenantId: string; tenantName: string }>) ?? []
  const tenant = tenants.find((t) => /Tarte Currumbin/i.test(t.tenantName)) ?? tenants[0]
  if (!tenant) throw new Error("no tenants stored")
  const t = tenant.tenantId
  console.log(`org: ${tenant.tenantName}\n`)

  // ---- 1. Every TARTE invoice, all statuses (DRAFT included) --------------
  console.log("=== TARTE EVENT INVOICES (all statuses) ===")
  try {
    const seen: string[] = []
    for (let page = 1; page <= 10; page++) {
      const r = await c.accountingApi.getInvoices(
        t,
        undefined,
        `Type=="ACCREC" AND Date>=DateTime(2026,1,1)`,
        "Date ASC",
        undefined,
        undefined,
        undefined,
        undefined,
        page
      )
      const invs = r.body.invoices ?? []
      if (invs.length === 0) break
      for (const i of invs) {
        const num = i.invoiceNumber ?? ""
        if (!/^TARTE-/i.test(num)) continue
        const paid = money(i.amountPaid)
        const due = money(i.amountDue)
        seen.push(
          `${num.padEnd(18)} ${String(i.status ?? "?").padEnd(10)} ${dateOf(i.date)} ` +
            `${(i.contact?.name ?? "?").padEnd(22)} total ${fmt(money(i.total)).padStart(10)} ` +
            `paid ${fmt(paid).padStart(10)} due ${fmt(due).padStart(10)}  ref="${i.reference ?? ""}"`
        )
      }
      if (invs.length < 100) break
    }
    console.log(seen.length ? seen.join("\n") : "(none found)")
  } catch (e) {
    console.log(`FAILED: ${safeErr(e)}`)
  }

  // ---- 2. Prepayments (deposits recorded the correct way) ----------------
  console.log("\n=== PREPAYMENTS ===")
  try {
    const r = await c.accountingApi.getPrepayments(
      t,
      undefined,
      `Date>=DateTime(2026,6,1)`,
      "Date ASC"
    )
    const ps = r.body.prepayments ?? []
    if (!ps.length) console.log("(none)")
    for (const p of ps) {
      console.log(
        `${dateOf(p.date)} ${(p.contact?.name ?? "?").padEnd(22)} ` +
          `total ${fmt(money(p.total)).padStart(10)} remaining ${fmt(money(p.remainingCredit)).padStart(10)} ` +
          `status ${p.status ?? "?"} ref="${p.reference ?? ""}"`
      )
    }
  } catch (e) {
    console.log(`FAILED: ${safeErr(e)}`)
  }

  // ---- 3. Overpayments ---------------------------------------------------
  console.log("\n=== OVERPAYMENTS ===")
  try {
    const r = await c.accountingApi.getOverpayments(
      t,
      undefined,
      `Date>=DateTime(2026,6,1)`,
      "Date ASC"
    )
    const os = r.body.overpayments ?? []
    if (!os.length) console.log("(none)")
    for (const o of os) {
      console.log(
        `${dateOf(o.date)} ${(o.contact?.name ?? "?").padEnd(22)} ` +
          `total ${fmt(money(o.total)).padStart(10)} remaining ${fmt(money(o.remainingCredit)).padStart(10)} ` +
          `status ${o.status ?? "?"}`
      )
    }
  } catch (e) {
    console.log(`FAILED: ${safeErr(e)}`)
  }

  // ---- 4. Credit notes with credit left ---------------------------------
  console.log("\n=== ACCREC CREDIT NOTES ===")
  try {
    const r = await c.accountingApi.getCreditNotes(
      t,
      undefined,
      `Type=="ACCRECCREDIT" AND Date>=DateTime(2026,6,1)`,
      "Date ASC"
    )
    const cs = r.body.creditNotes ?? []
    if (!cs.length) console.log("(none)")
    for (const cn of cs) {
      console.log(
        `${dateOf(cn.date)} ${(cn.contact?.name ?? "?").padEnd(22)} ` +
          `total ${fmt(money(cn.total)).padStart(10)} remaining ${fmt(money(cn.remainingCredit)).padStart(10)} ` +
          `status ${cn.status ?? "?"}`
      )
    }
  } catch (e) {
    console.log(`FAILED: ${safeErr(e)}`)
  }

  // ---- 5. Incoming bank receipts that aren't POS settlements -------------
  console.log(`\n=== RECEIVE BANK TRANSACTIONS since ${SINCE} (POS settlements excluded) ===`)
  try {
    const rows: string[] = []
    for (let page = 1; page <= 10; page++) {
      const r = await c.accountingApi.getBankTransactions(
        t,
        undefined,
        `Type=="RECEIVE" AND Date>=DateTime(2026,6,1)`,
        "Date ASC",
        page
      )
      const txns = r.body.bankTransactions ?? []
      if (txns.length === 0) break
      for (const b of txns) {
        const name = b.contact?.name ?? "?"
        if (NOISE.test(name)) continue
        rows.push(
          `${dateOf(b.date)} ${name.padEnd(26)} ${fmt(money(b.total)).padStart(10)} ` +
            `recon=${b.isReconciled ? "Y" : "N"} ref="${b.reference ?? ""}"`
        )
      }
      if (txns.length < 100) break
    }
    console.log(rows.length ? rows.join("\n") : "(none)")
  } catch (e) {
    console.log(`FAILED: ${safeErr(e)}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("DEPOSIT AUDIT FAILED:", safeErr(e))
    process.exit(1)
  })
