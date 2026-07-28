// Tarte-branded event/deposit invoice PDF generator (no Xero). Matches the
// look of Tarte's real event invoices: sage branding, Beach House logo, event
// details block, line items, 50% deposit split, bank details and terms.

import PDFDocument from "pdfkit"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { config } from "../config.js"
import { db } from "../db/pool.js"

const ATTACHMENTS_DIR = "/app/attachments"
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets")

// Tarte brand palette (sage).
const SAGE = "#9ab5b0"
const SAGE_DARK = "#6e8d85"
const INK = "#3a3a3a"
const MUTED = "#8a8a8a"
const RULE = "#e2e8e6"

export interface InvoiceConfig {
  businessName: string
  abn: string
  address: string
  email: string
  phone: string
  bankAccountName: string
  bankName: string
  bankBsb: string
  bankAccountNumber: string
  logoPath: string | undefined
  gstRegistered: boolean
  prefix: string
  dueDays: number
}

export function invoiceConfigReady(): boolean {
  const c = config()
  return Boolean(
    c.INVOICE_BUSINESS_NAME &&
      c.INVOICE_ABN &&
      c.INVOICE_BANK_ACCOUNT_NAME &&
      c.INVOICE_BANK_BSB &&
      c.INVOICE_BANK_ACCOUNT_NUMBER
  )
}

function invoiceConfig(): InvoiceConfig {
  const c = config()
  return {
    businessName: c.INVOICE_BUSINESS_NAME ?? "Tarte Currumbin Pty Ltd",
    abn: c.INVOICE_ABN ?? "",
    address: c.INVOICE_ADDRESS ?? "Shop 1, 2-4 Thrower Drive, Currumbin QLD 4223",
    email: c.INVOICE_EMAIL ?? c.HELLO_MAILBOX,
    phone: c.INVOICE_PHONE ?? "",
    bankAccountName: c.INVOICE_BANK_ACCOUNT_NAME ?? "",
    bankName: c.INVOICE_BANK_NAME ?? "",
    bankBsb: c.INVOICE_BANK_BSB ?? "",
    bankAccountNumber: c.INVOICE_BANK_ACCOUNT_NUMBER ?? "",
    logoPath: c.INVOICE_LOGO_PATH,
    gstRegistered: c.INVOICE_GST_REGISTERED,
    prefix: c.INVOICE_NUMBER_PREFIX,
    dueDays: c.INVOICE_DEPOSIT_DUE_DAYS,
  }
}

export interface LineItem {
  description: string
  qty: number
  unitPrice: number
}

export interface EventDetails {
  eventType?: string
  packageName?: string
  dateLabel?: string
  timeLabel?: string
  guestsLabel?: string
  dietaries?: string
}

export interface InvoiceInput {
  bookingId: number | null
  threadId: string
  customerName: string
  customerEmail: string
  customerPhone?: string
  event?: EventDetails
  lineItems: LineItem[]
  // When set (e.g. 50), the invoice shows a deposit + balance split and the
  // amount due now is the deposit. When null, the full total is due.
  depositPct?: number | null
  // "standard" = the deposit/full invoice. "balance" = the remaining amount
  // once the deposit has been paid; shows "deposit received" + "balance due now".
  kind?: "standard" | "balance"
  // For a balance invoice: how much deposit was already paid (subtracted from
  // the total to show the balance now due).
  depositPaidAmount?: number | null
  // Actual money received against this invoice (bank-verified or staff-entered).
  // Overrides the pct-derived deposit maths: partial → "Payment received" +
  // remaining balance due; >= total → renders as PAID IN FULL (a receipt).
  amountPaid?: number | null
  todayBrisbane: string // YYYY-MM-DD
  // Optional explicit due dates (else derived). ISO yyyy-mm-dd or label.
  depositDueLabel?: string
  totalDueLabel?: string
  notes?: string[]
}

const DEFAULT_NOTES = [
  "50% deposit due 2 weeks prior to the event to save the date.",
  "Remaining balance due 2 days prior to the event start time.",
  "Final numbers and dietaries required 2 days prior to the event.",
  "Dietary requirements may incur an additional fee.",
]

export interface GeneratedInvoice {
  pdf: Buffer
  invoiceNumber: string
}

async function reserveInvoiceNumber(input: InvoiceInput, amount: number): Promise<string> {
  const { prefix } = invoiceConfig()
  const year = input.todayBrisbane.slice(0, 4)
  const kind = input.kind ?? "standard"
  // Idempotent by booking OR thread, scoped to this invoice KIND — so the
  // deposit invoice and a later balance invoice for the same booking each get
  // their own stable number rather than colliding.
  const existing = await db().query<{ invoice_number: string }>(
    `SELECT invoice_number FROM inbox_invoices
      WHERE invoice_number <> 'PENDING'
        AND kind = $3
        AND ( ($1::bigint IS NOT NULL AND booking_id = $1)
              OR thread_id = $2 )
      ORDER BY id LIMIT 1`,
    [input.bookingId, input.threadId, kind]
  )
  if (existing.rows[0]) return existing.rows[0].invoice_number
  const desc = input.event?.packageName ?? input.lineItems[0]?.description ?? "Function"
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO inbox_invoices
       (invoice_number, booking_id, thread_id, customer_name, customer_email, amount, description, kind)
     VALUES ('PENDING', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.bookingId, input.threadId, input.customerName, input.customerEmail, amount, desc, kind]
  )
  const id = rows[0]!.id
  const number = `${prefix}-${year}-${String(id).padStart(5, "0")}`
  await db().query(`UPDATE inbox_invoices SET invoice_number = $1 WHERE id = $2`, [number, id])
  return number
}

function fmtAud(n: number): string {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDateLabel(d: Date): string {
  return d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

async function loadImage(explicit: string | undefined, assetFallback: string): Promise<Buffer | null> {
  // Prefer a configured logo in the attachments dir; fall back to the bundled
  // asset so it always renders.
  if (explicit && !explicit.includes("..") && !explicit.startsWith("/")) {
    try {
      return await readFile(join(ATTACHMENTS_DIR, explicit))
    } catch {
      /* fall through */
    }
  }
  try {
    return await readFile(join(ASSET_DIR, assetFallback))
  } catch {
    return null
  }
}

/** Public: build a full event/deposit invoice, record it, return PDF + number. */
export async function generateInvoice(input: InvoiceInput): Promise<GeneratedInvoice> {
  const cfg = invoiceConfig()
  const gross = input.lineItems.reduce((s, li) => s + li.qty * li.unitPrice, 0)
  const invoiceNumber = await reserveInvoiceNumber(input, gross)
  const logo = await loadImage(cfg.logoPath, "tarte-logo.png")
  const thankyou = await loadImage(undefined, "tarte-thankyou.png")
  const issueDate = new Date(`${input.todayBrisbane}T00:00:00+10:00`)
  const pdf = await renderInvoicePdf({ cfg, input, invoiceNumber, gross, issueDate, logo, thankyou })
  // Keep the bytes so we can archive a copy to Drive once the draft is sent —
  // and keep the stored amount in step with the regenerated total. The amount
  // was previously only written at number-reservation time, so every rebuild
  // (guest count change, added cake, staff edit) left the row showing the
  // ORIGINAL total while the PDF said something else (Isabella Stenta:
  // row $110 vs PDF $265, 2026-07-28 sweep).
  await db()
    .query(`UPDATE inbox_invoices SET pdf_bytes = $1, amount = $3 WHERE invoice_number = $2`, [
      pdf,
      invoiceNumber,
      gross,
    ])
    .catch((e) => console.error("[invoice] failed to persist pdf bytes:", e instanceof Error ? e.message : e))
  return { pdf, invoiceNumber }
}

/** Thin wrapper for the save-the-date deposit-only case (live booking flow). */
export async function generateDepositInvoice(opts: {
  bookingId: number | null
  threadId: string
  customerName: string
  customerEmail: string
  venueLabel: string
  eventDate: Date
  amount: number
  todayBrisbane: string
}): Promise<GeneratedInvoice> {
  return generateInvoice({
    bookingId: opts.bookingId,
    threadId: opts.threadId,
    customerName: opts.customerName,
    customerEmail: opts.customerEmail,
    event: {
      eventType: "Function",
      packageName: `${opts.venueLabel} function`,
      dateLabel: fmtDateLabel(opts.eventDate),
    },
    lineItems: [
      { description: `Save-the-date deposit — ${opts.venueLabel} function`, qty: 1, unitPrice: opts.amount },
    ],
    depositPct: null,
    todayBrisbane: opts.todayBrisbane,
    notes: DEFAULT_NOTES,
  })
}

export function renderInvoicePdf(p: {
  cfg: InvoiceConfig
  input: InvoiceInput
  invoiceNumber: string
  gross: number
  issueDate: Date
  logo: Buffer | null
  thankyou: Buffer | null
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0 })
    const chunks: Buffer[] = []
    doc.on("data", (c: Buffer) => chunks.push(c))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const { cfg, input } = p
    const L = 50 // left margin
    const R = 545 // right edge
    const W = R - L

    // Money actually received. Staff-entered/bank-verified amountPaid wins;
    // a balance invoice with no recorded amount falls back to the pct-derived
    // deposit so old flows render unchanged.
    const totalDue = p.gross
    const pctDeposit = input.depositPct
      ? Math.round(((totalDue * input.depositPct) / 100) * 100) / 100
      : null
    const received = Math.round(
      (input.amountPaid ?? (input.kind === "balance" ? input.depositPaidAmount ?? pctDeposit ?? 0 : 0)) * 100
    ) / 100
    const fullyPaid = received > 0 && received >= Math.round(totalDue * 100) / 100 - 0.005

    // ---- Header band ----
    if (p.logo) {
      try {
        doc.image(p.logo, L, 44, { fit: [165, 70] })
      } catch {
        doc.fillColor(SAGE_DARK).fontSize(24).font("Helvetica-Bold").text("Tarte.", L, 50)
      }
    } else {
      doc.fillColor(SAGE_DARK).fontSize(24).font("Helvetica-Bold").text("Tarte.", L, 50)
    }
    doc
      .fillColor(SAGE_DARK)
      .fontSize(22)
      .font("Helvetica-Bold")
      .text(cfg.gstRegistered ? "TAX INVOICE" : "INVOICE", R - 220, 50, { width: 220, align: "right" })
    if (fullyPaid) {
      // Small tag in the gap under the logo (logo ends ~114, rule at 128).
      doc.fillColor(SAGE_DARK).fontSize(9).font("Helvetica-Bold").text("PAID IN FULL — NOTHING OWING", L, 117)
    } else if (input.kind === "balance") {
      doc.fillColor(SAGE_DARK).fontSize(9).font("Helvetica-Bold").text("BALANCE INVOICE — REMAINING AMOUNT DUE", L, 117)
    }
    doc.fillColor(MUTED).fontSize(9.5).font("Helvetica")
    doc.text("Invoice", R - 220, 82, { width: 130, align: "right" })
    doc.text("Date", R - 220, 96, { width: 130, align: "right" })
    doc.fillColor(INK).font("Helvetica-Bold")
    doc.text(p.invoiceNumber, R - 90, 82, { width: 90, align: "right" })
    doc.font("Helvetica").fillColor(INK).text(fmtDateLabel(p.issueDate).replace(/^\w+ /, ""), R - 90, 96, { width: 90, align: "right" })

    doc.moveTo(L, 128).lineTo(R, 128).lineWidth(1).strokeColor(SAGE).stroke()

    // ---- Billed to ----
    let y = 148
    doc.fillColor(SAGE_DARK).fontSize(9).font("Helvetica-Bold").text("BILLED TO", L, y)
    doc.fillColor(INK).fontSize(13).font("Helvetica-Bold").text(input.customerName || "Customer", L, y + 14)
    doc.fillColor(MUTED).fontSize(10).font("Helvetica")
    const billLines = [input.customerEmail, input.customerPhone].filter(Boolean) as string[]
    doc.text(billLines.join("\n"), L, y + 32)

    // ---- Event details panel (right) ----
    // Row heights are measured per-value so long Event/Package text wraps
    // cleanly instead of overlapping the next row.
    if (input.event) {
      const ev = input.event
      const rows: Array<[string, string]> = []
      if (ev.eventType) rows.push(["Event", ev.eventType])
      if (ev.packageName) rows.push(["Package", ev.packageName])
      if (ev.dateLabel) rows.push(["Date", ev.dateLabel])
      if (ev.timeLabel) rows.push(["Time", ev.timeLabel])
      if (ev.guestsLabel) rows.push(["Guests", ev.guestsLabel])
      if (ev.dietaries) rows.push(["Dietaries", ev.dietaries])
      const panelX = 285
      const panelW = R - panelX
      const labelW = 62
      const valX = panelX + 12 + labelW
      const valW = R - valX - 12
      const padTop = 9
      const gap = 6
      doc.fontSize(9.5).font("Helvetica")
      const heights = rows.map(([, v]) =>
        Math.max(12, doc.heightOfString(v, { width: valW, align: "right" }))
      )
      const panelH = padTop * 2 + heights.reduce((a, b) => a + b + gap, 0) - gap
      doc.roundedRect(panelX, y, panelW, panelH, 6).fill("#f3f7f6")
      let ry = y + padTop
      rows.forEach(([k, v], i) => {
        doc.fillColor(SAGE_DARK).fontSize(9).font("Helvetica-Bold").text(k, panelX + 12, ry + 1, { width: labelW })
        doc.fillColor(INK).fontSize(9.5).font("Helvetica").text(v, valX, ry, { width: valW, align: "right" })
        ry += heights[i]! + gap
      })
      y = Math.max(y + 56, y + panelH)
    } else {
      y += 56
    }

    // ---- Line items table ----
    y += 18
    const cQty = 330
    const cUnit = 400
    const cAmt = R
    doc.rect(L, y, W, 22).fill(SAGE)
    doc.fillColor("#ffffff").fontSize(9).font("Helvetica-Bold")
    doc.text("DESCRIPTION", L + 10, y + 7)
    doc.text("QTY", cQty, y + 7, { width: 40, align: "right" })
    doc.text("UNIT PRICE", cUnit - 30, y + 7, { width: 70, align: "right" })
    doc.text("AMOUNT", cAmt - 90, y + 7, { width: 80, align: "right" })
    y += 22

    doc.font("Helvetica").fontSize(10).fillColor(INK)
    for (const li of input.lineItems) {
      const amt = li.qty * li.unitPrice
      const rowH = 24
      doc.fillColor(INK).text(li.description, L + 10, y + 7, { width: cQty - L - 20 })
      doc.text(String(li.qty), cQty, y + 7, { width: 40, align: "right" })
      doc.text(fmtAud(li.unitPrice), cUnit - 30, y + 7, { width: 70, align: "right" })
      doc.text(fmtAud(amt), cAmt - 90, y + 7, { width: 80, align: "right" })
      doc.moveTo(L, y + rowH).lineTo(R, y + rowH).lineWidth(0.5).strokeColor(RULE).stroke()
      y += rowH
    }

    // ---- Totals ----
    y += 14
    const total = p.gross
    const gst = cfg.gstRegistered ? total / 11 : 0
    const deposit = input.depositPct ? Math.round((total * input.depositPct) / 100 * 100) / 100 : null
    const balance = deposit != null ? total - deposit : null
    const tX = 320
    const labelW = 150
    const totalRow = (label: string, val: string, opts: { bold?: boolean; sage?: boolean; size?: number } = {}): void => {
      doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.size ?? 10)
      doc.fillColor(opts.sage ? SAGE_DARK : MUTED).text(label, tX, y, { width: labelW, align: "left" })
      doc.fillColor(opts.sage ? SAGE_DARK : INK).text(val, tX + labelW, y, { width: R - tX - labelW, align: "right" })
      y += opts.size ? opts.size + 8 : 17
    }
    if (received > 0) {
      // Money has come in: full total, less the payment received, leaving the
      // remaining amount now due — $0.00 and a PAID stamp when settled.
      const remaining = Math.max(0, Math.round((total - received) * 100) / 100)
      totalRow(cfg.gstRegistered ? "Total (incl. GST)" : "Total", fmtAud(total))
      totalRow(
        input.kind === "balance" && !fullyPaid ? "Deposit received" : "Payment received",
        `- ${fmtAud(received)}`
      )
      doc.moveTo(tX, y + 2).lineTo(R, y + 2).lineWidth(1).strokeColor(SAGE).stroke()
      y += 8
      totalRow(fullyPaid ? "Balance due" : "Balance due now", fmtAud(remaining), { bold: true, sage: true, size: 12 })
      if (cfg.gstRegistered) {
        doc.fillColor(MUTED).fontSize(8).font("Helvetica").text(`Total includes GST ${fmtAud(gst)}`, tX, y, { width: R - tX, align: "right" })
        y += 14
      }
      if (fullyPaid) {
        y += 6
        doc.roundedRect(tX, y, R - tX, 32, 6).lineWidth(1.5).strokeColor(SAGE_DARK).stroke()
        doc.fillColor(SAGE_DARK).fontSize(13).font("Helvetica-Bold")
          .text("PAID IN FULL — THANK YOU", tX, y + 10, { width: R - tX, align: "center" })
        y += 44
      }
    } else {
      if (deposit != null) {
        totalRow(`Deposit (${input.depositPct}%)`, fmtAud(deposit))
        totalRow("Balance due", fmtAud(balance!))
      }
      doc.moveTo(tX, y + 2).lineTo(R, y + 2).lineWidth(1).strokeColor(SAGE).stroke()
      y += 8
      totalRow(cfg.gstRegistered ? "Total (incl. GST)" : "Total", fmtAud(total), { bold: true, sage: true, size: 12 })
      if (cfg.gstRegistered) {
        doc.fillColor(MUTED).fontSize(8).font("Helvetica").text(`Includes GST ${fmtAud(gst)}`, tX, y, { width: R - tX, align: "right" })
        y += 14
      }
    }

    // ---- Due dates ---- (nothing is due on a settled invoice)
    if (!fullyPaid && (input.depositDueLabel || input.totalDueLabel)) {
      y += 6
      doc.fontSize(9).fillColor(MUTED).font("Helvetica")
      if (input.depositDueLabel) {
        doc.font("Helvetica-Bold").fillColor(SAGE_DARK).text("Deposit due", L, y, { continued: true })
          .font("Helvetica").fillColor(INK).text(`   ${input.depositDueLabel}`)
      }
      if (input.totalDueLabel) {
        doc.font("Helvetica-Bold").fillColor(SAGE_DARK).text("Balance due", L, y + 14, { continued: true })
          .font("Helvetica").fillColor(INK).text(`   ${input.totalDueLabel}`)
      }
      y += 30
    }

    // ---- Payment details (two columns; settled invoices need none) ----
    y += 10
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(RULE).stroke()
    y += 14
    doc.fillColor(SAGE_DARK).fontSize(10).font("Helvetica-Bold").text(fullyPaid ? "PAYMENT" : "PAYMENT DETAILS", L, y)
    y += 16
    if (fullyPaid) {
      doc.fillColor(INK).fontSize(9.5).font("Helvetica")
      doc.text("Payment received in full with thanks — no further payment is required.", L, y, { width: W })
      y = doc.y + 18
    } else {
    const colY = y
    doc.fillColor(INK).fontSize(9.5).font("Helvetica")
    doc.text(
      [
        "Bank transfer",
        cfg.bankAccountName ? `Account: ${cfg.bankAccountName}` : "",
        cfg.bankName,
        cfg.bankBsb ? `BSB: ${cfg.bankBsb}` : "",
        cfg.bankAccountNumber ? `Account no: ${cfg.bankAccountNumber}` : "",
        `Reference: ${p.invoiceNumber}`,
      ].filter(Boolean).join("\n"),
      L,
      colY,
      { width: 260 }
    )
    const bankBottom = doc.y
    doc.text(
      ["Credit card", "Payment in store or over the phone", "(incurs a surcharge)"].join("\n"),
      320,
      colY,
      { width: R - 320 }
    )
    // Advance below the TALLER of the two columns (bank block is taller).
    y = Math.max(bankBottom, doc.y) + 18
    }

    // ---- Notes / terms ----
    const notes = input.notes ?? DEFAULT_NOTES
    doc.fillColor(SAGE_DARK).fontSize(9).font("Helvetica-Bold").text("BOOKING CONDITIONS", L, y)
    y += 13
    doc.fillColor(MUTED).fontSize(8.5).font("Helvetica")
    for (const n of notes) {
      doc.text(`•  ${n}`, L, y, { width: W })
      y += 13
    }

    // ---- Business footer + thank you ----
    const footY = 770
    doc.fillColor(MUTED).fontSize(8).font("Helvetica")
    doc.text(
      [cfg.businessName, cfg.abn ? `ABN ${cfg.abn}` : "", cfg.address, cfg.email].filter(Boolean).join("  ·  "),
      L,
      footY,
      { width: 360 }
    )
    if (p.thankyou) {
      try {
        doc.image(p.thankyou, R - 110, footY - 14, { fit: [110, 40] })
      } catch {
        /* skip */
      }
    }

    doc.end()
  })
}
