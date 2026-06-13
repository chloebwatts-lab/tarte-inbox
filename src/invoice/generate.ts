// Tarte-branded deposit invoice PDF generator (no Xero). Produces a clean
// A4 tax invoice from the configured business + bank details, attached to the
// booking confirmation draft for staff to check before sending.

import PDFDocument from "pdfkit"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { config } from "../config.js"
import { db } from "../db/pool.js"

const ATTACHMENTS_DIR = "/app/attachments"

export interface InvoiceConfig {
  businessName: string
  abn: string
  address: string
  email: string
  phone: string
  bankAccountName: string
  bankBsb: string
  bankAccountNumber: string
  logoPath: string | undefined
  gstRegistered: boolean
  prefix: string
  dueDays: number
}

/** True only when the essentials needed for a valid invoice are configured. */
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
    businessName: c.INVOICE_BUSINESS_NAME ?? "",
    abn: c.INVOICE_ABN ?? "",
    address: c.INVOICE_ADDRESS ?? "",
    email: c.INVOICE_EMAIL ?? c.HELLO_MAILBOX,
    phone: c.INVOICE_PHONE ?? "",
    bankAccountName: c.INVOICE_BANK_ACCOUNT_NAME ?? "",
    bankBsb: c.INVOICE_BANK_BSB ?? "",
    bankAccountNumber: c.INVOICE_BANK_ACCOUNT_NUMBER ?? "",
    logoPath: c.INVOICE_LOGO_PATH,
    gstRegistered: c.INVOICE_GST_REGISTERED,
    prefix: c.INVOICE_NUMBER_PREFIX,
    dueDays: c.INVOICE_DEPOSIT_DUE_DAYS,
  }
}

export interface DepositInvoiceInput {
  bookingId: number | null
  threadId: string
  customerName: string
  customerEmail: string
  venueLabel: string // "Tea Garden" | "Beach House"
  eventDate: Date
  amount: number
  todayBrisbane: string // YYYY-MM-DD
}

/** Reserve the next invoice number, or reuse the existing one for this
 *  booking so re-processing a thread never burns a second number. */
async function reserveInvoiceNumber(
  input: DepositInvoiceInput,
  description: string
): Promise<string> {
  const { prefix } = invoiceConfig()
  const year = input.todayBrisbane.slice(0, 4)
  // Idempotent by booking: if we've already issued a deposit invoice for this
  // booking, reuse its number.
  if (input.bookingId != null) {
    const existing = await db().query<{ invoice_number: string }>(
      `SELECT invoice_number FROM inbox_invoices
        WHERE booking_id = $1 AND invoice_number <> 'PENDING'
        ORDER BY id LIMIT 1`,
      [input.bookingId]
    )
    if (existing.rows[0]) return existing.rows[0].invoice_number
  }
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO inbox_invoices
       (invoice_number, booking_id, thread_id, customer_name, customer_email, amount, description)
     VALUES ('PENDING', $1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.bookingId,
      input.threadId,
      input.customerName,
      input.customerEmail,
      input.amount,
      description,
    ]
  )
  const id = rows[0]!.id
  const number = `${prefix}-${year}-${String(id).padStart(5, "0")}`
  await db().query(
    `UPDATE inbox_invoices SET invoice_number = $1 WHERE id = $2`,
    [number, id]
  )
  return number
}

function fmtAud(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Brisbane",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

export interface GeneratedInvoice {
  pdf: Buffer
  invoiceNumber: string
}

export async function generateDepositInvoice(
  input: DepositInvoiceInput
): Promise<GeneratedInvoice> {
  const cfg = invoiceConfig()
  const description = `Deposit to secure your ${input.venueLabel} function on ${fmtDate(input.eventDate)}`
  const invoiceNumber = await reserveInvoiceNumber(input, description)

  // GST math: the deposit amount is GST-inclusive (AU convention).
  const total = input.amount
  const gst = cfg.gstRegistered ? total / 11 : 0
  const subtotal = total - gst

  const issueDate = new Date(`${input.todayBrisbane}T00:00:00+10:00`)
  const dueDate = new Date(issueDate.getTime() + cfg.dueDays * 86400_000)

  const logo = await loadLogo(cfg.logoPath)

  const pdf = await renderInvoicePdf({ cfg, input, invoiceNumber, description, total, gst, subtotal, issueDate, dueDate, logo })
  return { pdf, invoiceNumber }
}

async function loadLogo(logoPath: string | undefined): Promise<Buffer | null> {
  if (!logoPath) return null
  try {
    // Guard against path escape.
    if (logoPath.includes("..") || logoPath.startsWith("/")) return null
    return await readFile(join(ATTACHMENTS_DIR, logoPath))
  } catch {
    return null
  }
}

export function renderInvoicePdf(p: {
  cfg: InvoiceConfig
  input: DepositInvoiceInput
  invoiceNumber: string
  description: string
  total: number
  gst: number
  subtotal: number
  issueDate: Date
  dueDate: Date
  logo: Buffer | null
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 })
    const chunks: Buffer[] = []
    doc.on("data", (c: Buffer) => chunks.push(c))
    doc.on("end", () => resolve(Buffer.concat(chunks)))
    doc.on("error", reject)

    const { cfg } = p
    const ink = "#2b2b2b"
    const muted = "#777777"
    const left = 50
    const rightX = 350

    // --- Header: logo + business details ---
    let headerY = 50
    if (p.logo) {
      try {
        doc.image(p.logo, left, headerY, { fit: [140, 60] })
      } catch {
        /* bad image — skip */
      }
    } else {
      doc.fillColor(ink).fontSize(22).font("Helvetica-Bold").text(cfg.businessName, left, headerY)
    }
    // Right header block: business contact details (name is shown large on
    // the left when there's no logo, so don't repeat it here).
    doc
      .fillColor(muted)
      .fontSize(9)
      .font("Helvetica")
    const headerLines = [
      cfg.abn ? `ABN ${cfg.abn}` : "",
      ...cfg.address.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
      cfg.email,
      cfg.phone,
    ].filter(Boolean)
    doc.text(headerLines.join("\n"), rightX, headerY, { width: 195, align: "right" })

    // --- Title (left) + meta (right) on the same band ---
    const titleY = 160
    doc
      .fillColor(ink)
      .fontSize(20)
      .font("Helvetica-Bold")
      .text(cfg.gstRegistered ? "TAX INVOICE" : "INVOICE", left, titleY)

    doc.fontSize(10).font("Helvetica").fillColor(muted)
    doc.text(`Invoice number`, rightX, titleY, { width: 100, align: "left" })
    doc.text(`Date issued`, rightX, titleY + 16, { width: 100, align: "left" })
    doc.text(`Payment due`, rightX, titleY + 32, { width: 100, align: "left" })
    doc.fillColor(ink).font("Helvetica-Bold")
    doc.text(p.invoiceNumber, rightX + 100, titleY, { width: 95, align: "right" })
    doc.font("Helvetica")
    doc.text(fmtDate(p.issueDate), rightX + 100, titleY + 16, { width: 95, align: "right" })
    doc.text(fmtDate(p.dueDate), rightX + 100, titleY + 32, { width: 95, align: "right" })

    // --- Bill to (below the title, left) ---
    const billY = titleY + 50
    doc.fillColor(muted).fontSize(10).font("Helvetica").text("Bill to", left, billY)
    doc
      .fillColor(ink)
      .fontSize(12)
      .font("Helvetica-Bold")
      .text(p.input.customerName || "Customer", left, billY + 14)
    doc.fontSize(10).font("Helvetica").fillColor(muted).text(p.input.customerEmail, left, doc.y + 2)

    // --- Line items table ---
    const tableTop = 290
    doc.fillColor(ink).fontSize(10).font("Helvetica-Bold")
    doc.text("Description", left, tableTop)
    doc.text("Amount", rightX + 100, tableTop, { width: 95, align: "right" })
    doc.moveTo(left, tableTop + 16).lineTo(545, tableTop + 16).strokeColor("#dddddd").stroke()

    doc.font("Helvetica").fillColor(ink).fontSize(10)
    const rowY = tableTop + 26
    doc.text(p.description, left, rowY, { width: 380 })
    doc.text(fmtAud(p.total), rightX + 100, rowY, { width: 95, align: "right" })

    // --- Totals ---
    let ty = Math.max(doc.y, rowY) + 24
    doc.moveTo(rightX, ty).lineTo(545, ty).strokeColor("#dddddd").stroke()
    ty += 10
    const totalsRow = (label: string, value: string, bold = false): void => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fillColor(bold ? ink : muted).fontSize(10)
      doc.text(label, rightX, ty, { width: 100, align: "left" })
      doc.fillColor(ink).text(value, rightX + 100, ty, { width: 95, align: "right" })
      ty += 18
    }
    if (p.cfg.gstRegistered) {
      totalsRow("Subtotal", fmtAud(p.subtotal))
      totalsRow("GST (10%)", fmtAud(p.gst))
    }
    totalsRow("Total due", fmtAud(p.total), true)

    // --- Payment details ---
    const payY = ty + 24
    doc.fillColor(ink).fontSize(11).font("Helvetica-Bold").text("Payment details", left, payY)
    doc.fontSize(10).font("Helvetica").fillColor(ink)
    doc.text(
      [
        `Please transfer to:`,
        `Account name: ${cfg.bankAccountName}`,
        `BSB: ${cfg.bankBsb}`,
        `Account number: ${cfg.bankAccountNumber}`,
        `Reference: ${p.invoiceNumber}`,
      ].join("\n"),
      left,
      payY + 18
    )

    // --- Footer note ---
    doc
      .fillColor(muted)
      .fontSize(9)
      .font("Helvetica")
      .text(
        `This deposit secures your date and is applied toward your final balance. ` +
          `Please use the invoice number as your payment reference. Thank you!`,
        left,
        payY + 110,
        { width: 495 }
      )

    doc.end()
  })
}
