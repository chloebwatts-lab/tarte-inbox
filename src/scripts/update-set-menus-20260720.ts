// One-off: bring the LIVE bookings_dine_in FAQ in line with the new set menu
// packages (Chloe, 2026-07-20): Set Brunch $44pp and Set Lunch $65pp replace
// the old $40/$55 brunch pair. seed-faqs.ts never overwrites a non-empty live
// answer, so this targeted update is needed (same pattern as
// update-set-menu-faq.ts from earlier today).
//
// Idempotent — safe to run repeatedly.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/update-set-menus-20260720.js

import { migrate } from "../db/pool.js"
import { getPlaybook, upsertPlaybook } from "../db/queries.js"

const CATEGORY = "bookings_dine_in"

const BRUNCH_Q = "set brunch package at beach house restaurant?"
const BRUNCH_A =
  "$45 per person. 6-16 pax. Choice of main dish (avo toast, twice salmon bagel, or eggs your way with a side), housemade pastry, barista coffee or tea, and shared jugs of fresh juice."

const OLD_LUNCH_Q = "what does the $55 set restaurant brunch include?"
const LUNCH_Q = "What does the Set Lunch package include?"
const LUNCH_A =
  "$65 per person. 6-16 pax. Crispy chilli burrata, hot honey sourdough and seasonal green salad shared to start, then choice of main (crab linguine, steak and frites, grilled barramundi, or miso chicken sandwich with fries), housemade pastry to finish, and coffee or tea. Drinks otherwise on consumption."

async function main(): Promise<void> {
  await migrate()
  const pb = await getPlaybook(CATEGORY)
  if (!pb) {
    console.error(`[update-set-menus] playbook ${CATEGORY} not found`)
    process.exit(1)
  }
  const faq = [...(pb.faq ?? [])]
  const norm = (s: string): string => s.trim().toLowerCase()
  let changed = 0

  // 1. Brunch: update the answer in place.
  const bIdx = faq.findIndex((e) => norm(e.question) === BRUNCH_Q)
  if (bIdx !== -1 && faq[bIdx]!.answer.trim() !== BRUNCH_A) {
    faq[bIdx] = { ...faq[bIdx]!, answer: BRUNCH_A }
    changed++
  }

  // 2. Lunch: replace the retired "$55 set restaurant brunch" entry with the
  // Set Lunch entry (or update/insert the Set Lunch entry if already present).
  const oldIdx = faq.findIndex((e) => norm(e.question) === OLD_LUNCH_Q)
  const newIdx = faq.findIndex((e) => norm(e.question) === norm(LUNCH_Q))
  if (newIdx !== -1) {
    if (faq[newIdx]!.answer.trim() !== LUNCH_A) {
      faq[newIdx] = { ...faq[newIdx]!, answer: LUNCH_A }
      changed++
    }
    if (oldIdx !== -1) {
      faq.splice(oldIdx, 1)
      changed++
    }
  } else if (oldIdx !== -1) {
    faq[oldIdx] = { question: LUNCH_Q, answer: LUNCH_A }
    changed++
  } else {
    faq.push({ question: LUNCH_Q, answer: LUNCH_A })
    changed++
  }

  if (!changed) {
    console.log("[update-set-menus] already up to date — no change")
    process.exit(0)
  }
  await upsertPlaybook({ ...pb, faq })
  console.log(`[update-set-menus] applied ${changed} FAQ change(s):`)
  console.log(`  brunch -> ${BRUNCH_A}`)
  console.log(`  lunch  -> ${LUNCH_A}`)
  process.exit(0)
}

void main()
