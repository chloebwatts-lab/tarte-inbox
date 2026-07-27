// One-off: bring the LIVE bookings_dine_in Set Lunch FAQ in line with the
// updated pack page 12 (Chloe, 2026-07-27): seasonal green salad now
// accompanies the choice of main instead of being shared to start.
// seed-faqs.ts never overwrites a non-empty live answer, so this targeted
// update is needed (same pattern as update-set-menus-20260720.ts).
//
// Idempotent — safe to run repeatedly.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/update-set-lunch-salad-20260727.js

import { migrate } from "../db/pool.js"
import { getPlaybook, upsertPlaybook } from "../db/queries.js"

const CATEGORY = "bookings_dine_in"

const LUNCH_Q = "what does the set lunch package include?"
const LUNCH_A =
  "$65 per person. 12+ guests, main restaurant. Crispy chilli burrata and hot honey sourdough shared to start, then choice of main (crab linguine, steak and frites, grilled barramundi, or miso chicken sandwich with fries) served with seasonal green salad, housemade pastry to finish, and coffee or tea. Drinks otherwise on consumption."

async function main(): Promise<void> {
  await migrate()
  const pb = await getPlaybook(CATEGORY)
  if (!pb) {
    console.error(`[update-set-lunch-salad] playbook ${CATEGORY} not found`)
    process.exit(1)
  }
  const faq = [...(pb.faq ?? [])]
  const norm = (s: string): string => s.trim().toLowerCase()
  const idx = faq.findIndex((e) => norm(e.question) === LUNCH_Q)
  if (idx === -1) {
    console.error(`[update-set-lunch-salad] Set Lunch FAQ entry not found`)
    process.exit(1)
  }
  if (faq[idx]!.answer.trim() === LUNCH_A) {
    console.log("[update-set-lunch-salad] already up to date — no change")
    process.exit(0)
  }
  faq[idx] = { ...faq[idx]!, answer: LUNCH_A }
  await upsertPlaybook({ ...pb, faq })
  console.log(`[update-set-lunch-salad] updated:\n  ${LUNCH_A}`)
  process.exit(0)
}

void main()
