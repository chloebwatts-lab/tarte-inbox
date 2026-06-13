// Renders a sample deposit invoice PDF with placeholder details (no DB/env)
// so the layout can be eyeballed before real business details are supplied.
//   npx tsx src/scripts/test-invoice.ts   (writes /tmp/sample-invoice.pdf)

import { writeFile } from "node:fs/promises"
import { renderInvoicePdf, type InvoiceConfig } from "../invoice/generate.js"

const cfg: InvoiceConfig = {
  businessName: "Tarte Currumbin Pty Ltd",
  abn: "00 000 000 000",
  address: "Shop 1, 2-4 Thrower Drive, Currumbin QLD 4223",
  email: "hello@tarte.com.au",
  phone: "",
  bankAccountName: "Tarte Currumbin Pty Ltd",
  bankBsb: "000-000",
  bankAccountNumber: "00000000",
  logoPath: undefined,
  gstRegistered: true,
  prefix: "TARTE",
  dueDays: 7,
}

async function main(): Promise<void> {
  const pdf = await renderInvoicePdf({
    cfg,
    input: {
      bookingId: 1,
      threadId: "t",
      customerName: "Kiana Roberts",
      customerEmail: "kiana@example.com",
      venueLabel: "Tea Garden",
      eventDate: new Date("2026-09-20T02:00:00+10:00"),
      amount: 500,
      todayBrisbane: "2026-06-13",
    },
    invoiceNumber: "TARTE-2026-00042",
    description: "Deposit to secure your Tea Garden function on 20 September 2026",
    total: 500,
    gst: 500 / 11,
    subtotal: 500 - 500 / 11,
    issueDate: new Date("2026-06-13T00:00:00+10:00"),
    dueDate: new Date("2026-06-20T00:00:00+10:00"),
    logo: null,
  })
  await writeFile("/tmp/sample-invoice.pdf", pdf)
  console.log(`wrote /tmp/sample-invoice.pdf (${pdf.length} bytes)`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
