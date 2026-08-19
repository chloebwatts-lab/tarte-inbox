// Read-only: run the invoice extractor on a thread and print what the
// Make-Invoice label would do (build / unmet + why). No drafts, no invoices.
//   docker compose exec inbox node dist/scripts/test-extract-thread.js <threadId> [...]

import { getThread } from "../google/gmail.js"
import { extractInvoiceDetails, manuallyInvoiceable, isSaveTheDate, lineItemsFromExtraction, staffInstructionNotes } from "../invoice/from-thread.js"
import { fetchCustomerHistory, renderCustomerHistory } from "../google/customer-history.js"

function extractEmail(from: string): string {
  const m = /<([^>]+)>/.exec(from)
  return (m ? m[1]! : from).trim()
}
import { config } from "../config.js"

function todayBrisbane(): { date: string; weekday: string } {
  const now = new Date()
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(now)
  const weekday = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "long" }).format(now)
  return { date, weekday }
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2)
  if (!ids.length) throw new Error("usage: test-extract-thread.js <threadId> [...]")
  const { date, weekday } = todayBrisbane()
  const hello = config().HELLO_MAILBOX.toLowerCase()
  for (const id of ids) {
    const thread = await getThread(id)
    let customerMsg = thread.messages[thread.messages.length - 1]!
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      if (!thread.messages[i]!.from.toLowerCase().includes(hello)) {
        customerMsg = thread.messages[i]!
        break
      }
    }
    const addr = extractEmail(customerMsg.from) || ""
    const history = addr ? await fetchCustomerHistory(addr, id).catch(() => []) : []
    console.log(`=== ${id} (${thread.messages.length} msgs, customer ${addr})`)
    const notes = staffInstructionNotes(thread)
    console.log("staff notes:", notes ? `\n${notes}` : "(none)")
    const x = await extractInvoiceDetails(thread, date, weekday, renderCustomerHistory(history))
    if (!x.customer_email) x.customer_email = addr || null
    console.log(JSON.stringify(x, null, 1))
    console.log("manuallyInvoiceable:", manuallyInvoiceable(x), "| saveTheDate:", isSaveTheDate(x))
    console.log("lines:", JSON.stringify(lineItemsFromExtraction(x)))
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
