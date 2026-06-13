// Renders Jenna Strauch's deposit invoice with Tarte's real details so the
// design can be eyeballed.   npx tsx src/scripts/test-invoice.ts
import { writeFile } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { renderInvoicePdf, type InvoiceConfig } from "../invoice/generate.js"

const cfg: InvoiceConfig = {
  businessName: "Tarte Currumbin Pty Ltd",
  abn: "81 931 246 394",
  address: "Shop 1, 2-4 Thrower Drive, Currumbin QLD 4223",
  email: "hello@tarte.com.au",
  phone: "",
  bankAccountName: "The Saltwater Currumbin Trust",
  bankName: "Westpac",
  bankBsb: "034-604",
  bankAccountNumber: "436599",
  logoPath: undefined,
  gstRegistered: true,
  prefix: "TARTE",
  dueDays: 14,
}

async function main(): Promise<void> {
  const logo = await readFile(new URL("../../assets/tarte-logo.png", import.meta.url)).catch(() => null)
  const thankyou = await readFile(new URL("../../assets/tarte-thankyou.png", import.meta.url)).catch(() => null)
  const total = 32 * 89
  const pdf = await renderInvoicePdf({
    cfg,
    input: {
      bookingId: null,
      threadId: "t",
      customerName: "Jenna Strauch",
      customerEmail: "strauch.jenna.e@gmail.com",
      customerPhone: "+61 417 339 895",
      event: {
        eventType: "Baby Shower",
        packageName: "Private High Tea in The Hideout",
        dateLabel: "Saturday 1 August 2026  (to confirm)",
        timeLabel: "12:00pm - 3:00pm",
        guestsLabel: "32 Adults",
      },
      lineItems: [{ description: "High Tea — The Hideout (private)", qty: 32, unitPrice: 89 }],
      depositPct: 50,
      todayBrisbane: "2026-06-13",
      depositDueLabel: "Saturday 18 July 2026",
      totalDueLabel: "Thursday 30 July 2026",
    },
    invoiceNumber: "TARTE-2026-00001",
    gross: total,
    issueDate: new Date("2026-06-13T00:00:00+10:00"),
    logo,
    thankyou,
  })
  await writeFile("/tmp/jenna-invoice.pdf", pdf)
  console.log(`wrote /tmp/jenna-invoice.pdf (${pdf.length} bytes, total $${total})`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
