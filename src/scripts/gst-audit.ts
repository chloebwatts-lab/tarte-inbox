// Read-only GST input-tax-credit audit for the Tarte Currumbin Xero org.
//
// Why: GST leaks when a bill or bank payment is coded GST Free / BAS Excluded
// even though the supplier charged GST (single-line "lazy" bill entry for a
// mixed supplier, a bank-feed rule that defaulted to GST Free, a subscription
// billed from an AU-registered entity, rent, merchant fees, etc.). The ATO
// lets you claim a missed credit in a later BAS for four years from the due
// date of the BAS it belonged to, so nothing here needs an amendment — just a
// list to work through with the bookkeeper.
//
// What it pulls (all read-only):
//   1. tax rates + chart of accounts (names, default tax type per account)
//   2. every AUTHORISED/PAID supplier bill (ACCPAY) in the window, line by line
//   3. every SPEND bank transaction in the window, line by line — this is
//      where rent, merchant fees, subscriptions and card spend usually live,
//      and the Xero MCP connector cannot see them at all.
//
// What it flags (est_credit = the input credit that looks unclaimed):
//   A_zero_gst_on_taxable_account   0 GST on an account where >=70% of spend
//                                   normally carries GST
//   B_zero_gst_from_gst_supplier    0 GST from a supplier who charges GST on
//                                   >=70% of what we buy from them
//   C_single_line_zero_gst_mixed    one-line bill with no GST from a supplier
//                                   whose bills usually contain GST lines
//                                   (Bidfood / Provedores style entries)
//   D_gst_not_10pct                 GST present but not 10% of net (wrong
//                                   rate, or a partially coded line)
//   E_bas_excluded_on_expense       BAS Excluded / no tax type on an expense
//                                   or cost-of-sales account
//
// Usage (from the tarte-inbox host):
//   docker compose exec inbox node dist/scripts/gst-audit.js \
//       --from 2022-07-01 --to 2026-09-30 --out /tmp/gst-audit.csv [--all /tmp/gst-lines.csv]
//   docker compose cp inbox:/tmp/gst-audit.csv ./gst-audit.csv
//
// Writes nothing to Xero except the rotated refresh token (same as
// test-xero.js). Never console.error a xero-node error wholesale — they carry
// the raw Bearer token.

import { writeFileSync } from "node:fs"
import { xero } from "../xero/client.js"
import { getTokens, saveTokens } from "../db/queries.js"

// ---------------------------------------------------------------- args ----
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  return v && !v.startsWith("--") ? v : fallback
}
const today = new Date().toISOString().slice(0, 10)
const FROM = arg("from", fourYearsBackQuarterStart())
const TO = arg("to", today)
const OUT = arg("out", "/tmp/gst-audit.csv")
const ALL = arg("all", "")

/** First day of the quarter four years ago — roughly the oldest BAS period a
 * missed credit can still be picked up in. */
function fourYearsBackQuarterStart(): string {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() - 4)
  const q = Math.floor(d.getUTCMonth() / 3) * 3
  return `${d.getUTCFullYear()}-${String(q + 1).padStart(2, "0")}-01`
}

// ------------------------------------------------------------- helpers ----
function money(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const fmt = (n: number): string => `$${n.toFixed(2)}`
function dateOf(v: unknown): string {
  return v ? String(v).slice(0, 10) : "?"
}
function xeroDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  return `DateTime(${y},${m},${d})`
}
/** BAS quarter label, e.g. 2025-Q1 (Jul–Sep 2025 = Q1 of FY26 in ATO speak
 * is confusing, so we label by calendar: 2025-07 .. 2025-09 -> "Jul-Sep 2025"). */
function basQuarter(iso: string): string {
  const y = iso.slice(0, 4)
  const m = Number(iso.slice(5, 7))
  const names = ["Jan-Mar", "Apr-Jun", "Jul-Sep", "Oct-Dec"] as const
  return `${names[Math.floor((m - 1) / 3)] ?? "?"} ${y}`
}
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/** xero-node rejects with a plain object whose request headers hold the live
 * Bearer token, and it is NOT an Error — never stringify it wholesale. */
function safeErr(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  const r = (e as { response?: { statusCode?: number; body?: { Detail?: string } } })?.response
  if (r?.statusCode) {
    const scope = r.statusCode === 401 ? " — the app's Xero scopes don't cover this endpoint" : ""
    return `HTTP ${r.statusCode}${r.body?.Detail ? ` (${r.body.Detail})` : ""}${scope}`
  }
  return "unknown error (details suppressed: xero-node errors embed the bearer token)"
}
/** Xero allows 60 calls/min per org; ~1.1s between pages keeps us under it. */
const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 1100))

// --------------------------------------------------------------- types ----
interface Line {
  source: "bill" | "spend"
  doc_id: string
  date: string
  quarter: string
  supplier: string
  doc_number: string
  reference: string
  account_code: string
  account_name: string
  account_class: string
  description: string
  amount_type: string
  net: number
  tax: number
  tax_type: string
  tax_rate_name: string
  tax_rate: number
  has_attachment: boolean
  line_count: number
}
interface Flag extends Line {
  flag: string
  est_credit: number
}

// ---------------------------------------------------------------- main ----
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
  console.log(`org: ${tenant.tenantName}   window: ${FROM} .. ${TO}\n`)

  // ---- 1. tax rates + accounts -------------------------------------------
  const rates = new Map<string, { name: string; rate: number }>()
  const tr = await c.accountingApi.getTaxRates(t)
  for (const r of tr.body.taxRates ?? []) {
    if (r.taxType) rates.set(r.taxType, { name: r.name ?? r.taxType, rate: money(r.effectiveRate) })
  }
  await pause()
  const accounts = new Map<string, { name: string; cls: string; taxType: string }>()
  const ar = await c.accountingApi.getAccounts(t)
  for (const a of ar.body.accounts ?? []) {
    if (a.code) accounts.set(a.code, { name: a.name ?? "", cls: String(a._class ?? ""), taxType: a.taxType ?? "" })
  }
  console.log(`tax rates: ${rates.size}   accounts: ${accounts.size}`)
  await pause()

  const lines: Line[] = []
  const pushLines = (
    source: Line["source"],
    docId: string,
    date: string,
    supplier: string,
    docNumber: string,
    reference: string,
    amountType: string,
    hasAttachment: boolean,
    items: Array<{
      accountCode?: string
      description?: string
      lineAmount?: number
      taxAmount?: number
      taxType?: string
    }>
  ): void => {
    for (const li of items) {
      const code = li.accountCode ?? ""
      const acct = accounts.get(code)
      const taxType = li.taxType ?? ""
      const rate = rates.get(taxType)
      const gross = money(li.lineAmount)
      const tax = money(li.taxAmount)
      // lineAmount is tax-inclusive when the doc is Inclusive, else net.
      const net = amountType === "Inclusive" ? gross - tax : gross
      lines.push({
        source,
        doc_id: docId,
        date,
        quarter: basQuarter(date),
        supplier,
        doc_number: docNumber,
        reference,
        account_code: code,
        account_name: acct?.name ?? "",
        account_class: acct?.cls ?? "",
        description: li.description ?? "",
        amount_type: amountType,
        net,
        tax,
        tax_type: taxType,
        tax_rate_name: rate?.name ?? taxType,
        tax_rate: rate?.rate ?? 0,
        has_attachment: hasAttachment,
        line_count: items.length,
      })
    }
  }

  // ---- 2. supplier bills --------------------------------------------------
  let billCount = 0
  try {
    const where = `Type=="ACCPAY" AND Date>=${xeroDate(FROM)} AND Date<=${xeroDate(TO)}`
    for (let page = 1; page <= 500; page++) {
      const r = await c.accountingApi.getInvoices(
        t,
        undefined,
        where,
        "Date ASC",
        undefined,
        undefined,
        undefined,
        ["AUTHORISED", "PAID"],
        page,
        undefined,
        undefined,
        undefined,
        undefined,
        100
      )
      const invs = r.body.invoices ?? []
      if (invs.length === 0) break
      for (const i of invs) {
        billCount++
        pushLines(
          "bill",
          i.invoiceID ?? "",
          dateOf(i.date),
          i.contact?.name ?? "?",
          i.invoiceNumber ?? "",
          i.reference ?? "",
          String(i.lineAmountTypes ?? ""),
          Boolean(i.hasAttachments),
          i.lineItems ?? []
        )
      }
      process.stdout.write(`\rbills: page ${page}, ${billCount} bills, ${lines.length} lines`)
      if (invs.length < 100) break
      await pause()
    }
    console.log()
  } catch (e) {
    console.log(`\nBILLS FAILED: ${safeErr(e)}`)
  }

  // ---- 3. spend-money bank transactions ----------------------------------
  let spendCount = 0
  const billLines = lines.length
  try {
    const where = `Type=="SPEND" AND Status=="AUTHORISED" AND Date>=${xeroDate(FROM)} AND Date<=${xeroDate(TO)}`
    for (let page = 1; page <= 500; page++) {
      const r = await c.accountingApi.getBankTransactions(t, undefined, where, "Date ASC", page, undefined, 100)
      const txns = r.body.bankTransactions ?? []
      if (txns.length === 0) break
      for (const b of txns) {
        spendCount++
        pushLines(
          "spend",
          b.bankTransactionID ?? "",
          dateOf(b.date),
          b.contact?.name ?? "?",
          "",
          b.reference ?? "",
          String(b.lineAmountTypes ?? ""),
          Boolean(b.hasAttachments),
          b.lineItems ?? []
        )
      }
      process.stdout.write(`\rspend: page ${page}, ${spendCount} txns, ${lines.length - billLines} lines`)
      if (txns.length < 100) break
      await pause()
    }
    console.log()
  } catch (e) {
    console.log(`\nSPEND FAILED: ${safeErr(e)} (needs the accounting.banktransactions.read scope — re-link at /oauth/xero/start if missing)`)
  }

  // ---- 4. profiles --------------------------------------------------------
  const claimed = (l: Line): boolean => l.tax > 0.004
  const acctProf = new Map<string, { gst: number; net: number; n: number }>()
  const suppProf = new Map<string, { gst: number; net: number; docs: Set<string>; docsWithGst: Set<string> }>()
  for (const l of lines) {
    const n = Math.abs(l.net)
    const a = acctProf.get(l.account_code) ?? { gst: 0, net: 0, n: 0 }
    a.net += n; a.n++; if (claimed(l)) a.gst += n
    acctProf.set(l.account_code, a)
    const s = suppProf.get(l.supplier) ?? { gst: 0, net: 0, docs: new Set(), docsWithGst: new Set() }
    s.net += n; s.docs.add(l.doc_id); if (claimed(l)) { s.gst += n; s.docsWithGst.add(l.doc_id) }
    suppProf.set(l.supplier, s)
  }
  const share = (p: { gst: number; net: number }): number => (p.net > 0 ? p.gst / p.net : 0)
  const taxableAcct = new Set([...acctProf].filter(([, p]) => p.n >= 5 && share(p) >= 0.7).map(([k]) => k))
  const gstSupp = new Set([...suppProf].filter(([, p]) => p.docs.size >= 3 && share(p) >= 0.7).map(([k]) => k))
  const mixedSupp = new Set(
    [...suppProf].filter(([, p]) => p.docs.size >= 5 && p.docsWithGst.size / p.docs.size >= 0.5).map(([k]) => k)
  )
  const expenseClass = (cls: string): boolean => /EXPENSE|DIRECTCOSTS|OVERHEADS/i.test(cls)

  // ---- 5. flags -----------------------------------------------------------
  const flags: Flag[] = []
  const single = new Map<string, Line>()
  for (const l of lines) if (l.line_count === 1) single.set(l.doc_id, l)
  for (const l of lines) {
    const n = Math.abs(l.net)
    if (n < 0.01) continue
    const sp = suppProf.get(l.supplier)
    const isSingleZero = l.line_count === 1 && !claimed(l)
    if (!claimed(l)) {
      if (isSingleZero && mixedSupp.has(l.supplier) && sp) {
        flags.push({ ...l, flag: "C_single_line_zero_gst_mixed", est_credit: round2((n * share(sp)) / 10) })
        continue
      }
      if (taxableAcct.has(l.account_code)) {
        flags.push({ ...l, flag: "A_zero_gst_on_taxable_account", est_credit: round2(n / 10) })
      } else if (gstSupp.has(l.supplier)) {
        flags.push({ ...l, flag: "B_zero_gst_from_gst_supplier", est_credit: round2(n / 10) })
      } else if (
        (/^(BASEXCLUDED|NONE)$/i.test(l.tax_type) || l.tax_type === "") &&
        expenseClass(l.account_class) &&
        n >= 20
      ) {
        flags.push({ ...l, flag: "E_bas_excluded_on_expense", est_credit: round2(n / 10) })
      }
    } else {
      const expected = n / 10
      if (Math.abs(Math.abs(l.tax) - expected) > Math.max(0.05, expected * 0.03)) {
        flags.push({ ...l, flag: "D_gst_not_10pct", est_credit: round2(expected - Math.abs(l.tax)) })
      }
    }
  }
  flags.sort((a, b) => b.est_credit - a.est_credit)

  // ---- 6. output ----------------------------------------------------------
  const cols: Array<keyof Flag> = [
    "flag", "est_credit", "source", "date", "quarter", "supplier", "doc_number", "reference",
    "account_code", "account_name", "description", "net", "tax", "tax_type", "tax_rate_name",
    "amount_type", "line_count", "has_attachment", "doc_id",
  ]
  writeFileSync(OUT, [cols.join(","), ...flags.map((f) => cols.map((k) => csvCell(f[k])).join(","))].join("\n") + "\n")
  if (ALL) {
    const lc: Array<keyof Line> = cols.filter((k): k is keyof Line => k !== "flag" && k !== "est_credit")
    writeFileSync(ALL, [lc.join(","), ...lines.map((l) => lc.map((k) => csvCell(l[k])).join(","))].join("\n") + "\n")
  }

  console.log(`\n${billCount} bills + ${spendCount} spend txns = ${lines.length} lines; ${flags.length} flagged -> ${OUT}${ALL ? ` (all lines -> ${ALL})` : ""}`)
  const sum = (arr: Flag[]): number => arr.reduce((a, f) => a + f.est_credit, 0)
  const group = (key: (f: Flag) => string): Array<[string, Flag[]]> => {
    const m = new Map<string, Flag[]>()
    for (const f of flags) m.set(key(f), [...(m.get(key(f)) ?? []), f])
    return [...m].sort((a, b) => sum(b[1]) - sum(a[1]))
  }
  console.log("\n=== BY FLAG ===")
  for (const [k, v] of group((f) => f.flag)) console.log(`${k.padEnd(34)} ${String(v.length).padStart(5)} lines  est ${fmt(sum(v)).padStart(12)}`)
  console.log("\n=== BY BAS QUARTER (oldest first; anything older than 4 years is lost) ===")
  for (const [k, v] of group((f) => f.quarter).sort((a, b) => (a[1][0]?.date ?? "").localeCompare(b[1][0]?.date ?? "")))
    console.log(`${k.padEnd(14)} ${String(v.length).padStart(5)} lines  est ${fmt(sum(v)).padStart(12)}`)
  console.log("\n=== TOP 30 SUPPLIERS ===")
  for (const [k, v] of group((f) => f.supplier).slice(0, 30))
    console.log(`${k.slice(0, 36).padEnd(36)} ${String(v.length).padStart(5)} lines  est ${fmt(sum(v)).padStart(12)}   ${[...new Set(v.map((f) => f.flag[0]))].join("")}`)
  console.log("\n=== TOP 30 ACCOUNTS ===")
  for (const [k, v] of group((f) => `${f.account_code} ${f.account_name}`).slice(0, 30))
    console.log(`${k.slice(0, 40).padEnd(40)} ${String(v.length).padStart(5)} lines  est ${fmt(sum(v)).padStart(12)}`)
  console.log("\n=== ACCOUNT TAX PROFILE (share of net that carried GST) ===")
  for (const [code, p] of [...acctProf].sort((a, b) => b[1].net - a[1].net).slice(0, 40)) {
    const a = accounts.get(code)
    console.log(`${code.padEnd(7)} ${(a?.name ?? "").slice(0, 34).padEnd(34)} net ${fmt(p.net).padStart(13)}  gst ${(share(p) * 100).toFixed(0).padStart(3)}%  default ${a?.taxType ?? ""}`)
  }
  console.log("\nEstimates are 1/10 of net (1/11 of gross) — confirm each against the supplier's tax invoice before claiming.")
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("GST AUDIT FAILED:", safeErr(e))
    process.exit(1)
  })
