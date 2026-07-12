// Tidies hello@'s Gmail labels: keeps the ones the agent uses (category labels
// + Tarte/ status labels), deletes every other user-created label, and colour-
// codes the kept ones. System labels (Inbox, Sent, Spam…) are never touched.
//
// Dry-run by default (lists what it WOULD do). Pass --apply to make changes.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { CATEGORY_LABELS } from "../llm/classifier.js"
import {
  ACTION_LABEL,
  URGENT_LABEL,
  AUTO_HANDLED_LABEL,
  MAKE_INVOICE_LABEL,
  UPDATE_INVOICE_LABEL,
  INVOICE_CREATED_LABEL,
  INVOICE_SENT_LABEL,
  TAKEAWAY_HT_LABEL,
} from "../pipeline.js"

// Colour scheme (Gmail palette). Grouped by meaning: warm = attention,
// green = money, blue = events/bookings, etc. Dark bg → white text.
const C = (backgroundColor: string, textColor: string): { backgroundColor: string; textColor: string } => ({
  backgroundColor,
  textColor,
})
const COLORS: Record<string, { backgroundColor: string; textColor: string }> = {
  // attention
  [URGENT_LABEL]: C("#fb4c2f", "#ffffff"),
  "URGENT": C("#fb4c2f", "#ffffff"), // bare category label (applied alongside Tarte / URGENT)
  [ACTION_LABEL]: C("#ffad47", "#ffffff"),
  "Needs human": C("#ffbc6b", "#000000"),
  // money
  [MAKE_INVOICE_LABEL]: C("#16a766", "#ffffff"),
  [UPDATE_INVOICE_LABEL]: C("#16a766", "#ffffff"),
  [INVOICE_CREATED_LABEL]: C("#fcda83", "#000000"), // gold = awaiting send
  [INVOICE_SENT_LABEL]: C("#0b804b", "#ffffff"), // deep green = sent
  [TAKEAWAY_HT_LABEL]: C("#42d692", "#000000"), // mint = takeaway HT orders
  "Accounts / Invoices": C("#43d692", "#000000"),
  // events + bookings
  "Events / Tea Garden - High Tea": C("#4a86e8", "#ffffff"),
  "Events / Tea Garden - Functions": C("#4a86e8", "#ffffff"),
  "Events / Beach House - Functions": C("#4a86e8", "#ffffff"),
  "Bookings": C("#a4c2f4", "#000000"),
  "Bookings / Existing": C("#a4c2f4", "#000000"),
  // other inbound
  "Orders / Cakes & Catering": C("#f691b3", "#000000"),
  "General enquiries": C("#c9daf8", "#000000"),
  "Reviews": C("#fad165", "#000000"),
  "Suppliers": C("#b694e8", "#ffffff"),
  "Job applications": C("#cccccc", "#000000"),
  // quiet / done
  [AUTO_HANDLED_LABEL]: C("#b9e4d0", "#000000"),
  "No action": C("#cccccc", "#000000"),
  "Marketing / Cold outreach": C("#999999", "#ffffff"),
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const keep = new Set<string>([
    ...Object.values(CATEGORY_LABELS),
    ACTION_LABEL,
    URGENT_LABEL,
    AUTO_HANDLED_LABEL,
    MAKE_INVOICE_LABEL,
    UPDATE_INVOICE_LABEL,
    INVOICE_CREATED_LABEL,
    INVOICE_SENT_LABEL,
    TAKEAWAY_HT_LABEL,
  ])

  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })
  const res = await gmail.users.labels.list({ userId: "me" })
  const labels = (res.data.labels ?? []).filter((l) => l.type !== "system")

  const toDelete = labels.filter((l) => l.name && !keep.has(l.name))
  const toKeep = labels.filter((l) => l.name && keep.has(l.name))
  const missing = [...keep].filter((k) => !labels.some((l) => l.name === k))

  console.log(`\n=== ${apply ? "APPLYING" : "DRY RUN"} — ${labels.length} user labels on hello@ ===\n`)

  console.log(`KEEP + colour (${toKeep.length}):`)
  for (const l of toKeep) {
    const col = COLORS[l.name!]
    if (apply && col) {
      try {
        await gmail.users.labels.patch({ userId: "me", id: l.id!, requestBody: { color: col } })
        console.log(`  ✓ ${l.name}  -> ${col.backgroundColor}`)
      } catch (e) {
        console.log(`  ! ${l.name}  colour failed: ${e instanceof Error ? e.message : e}`)
      }
    } else {
      console.log(`  • ${l.name}  -> ${col ? col.backgroundColor : "(no colour mapped)"}`)
    }
  }

  console.log(`\nDELETE (${toDelete.length}):`)
  for (const l of toDelete) {
    if (apply) {
      try {
        await gmail.users.labels.delete({ userId: "me", id: l.id! })
        console.log(`  ✓ deleted ${l.name}`)
      } catch (e) {
        console.log(`  ! ${l.name}  delete failed: ${e instanceof Error ? e.message : e}`)
      }
    } else {
      console.log(`  • ${l.name}`)
    }
  }

  if (missing.length) {
    console.log(`\nCREATE missing agent labels (${missing.length}):`)
    for (const name of missing) {
      const col = COLORS[name]
      if (apply) {
        try {
          await gmail.users.labels.create({
            userId: "me",
            requestBody: {
              name,
              color: col,
              labelListVisibility: "labelShow",
              messageListVisibility: "show",
            },
          })
          console.log(`  ✓ created ${name}${col ? `  -> ${col.backgroundColor}` : ""}`)
        } catch (e) {
          console.log(`  ! ${name}  create failed: ${e instanceof Error ? e.message : e}`)
        }
      } else {
        console.log(`  • ${name}${col ? `  -> ${col.backgroundColor}` : ""}`)
      }
    }
  }
  console.log(`\nDone.${apply ? "" : "  Re-run with --apply to make these changes."}\n`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
