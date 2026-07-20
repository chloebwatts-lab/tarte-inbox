// One-off: refresh the live "set menu for large groups" FAQ answer to the
// current rule (Chloe, 2026-07-20): tables of 12+ need a set menu on every day
// EXCEPT Monday-Thursday (so Fri/Sat/Sun), not the old "more than 12 on
// weekends". seed-faqs.ts won't overwrite a non-empty live answer, so this
// targeted update is needed to stop the agent quoting the stale wording.
//
// Idempotent — safe to run repeatedly.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/update-set-menu-faq.js

import { migrate } from "../db/pool.js"
import { getPlaybook, upsertPlaybook } from "../db/queries.js"

const CATEGORY = "bookings_dine_in"
const QUESTION_MATCH = "do groups over 12 in the restaurant need a set menu?"
const NEW_ANSWER =
  "Yes - tables of 12 or more are required to go with a set menu on any day except Monday to Thursday (so it applies Friday, Saturday and Sunday). This helps deliver a smooth service for the group and other patrons during peak service times. Monday to Thursday, a group of 12 or more can order off the regular menu."

async function main(): Promise<void> {
  await migrate()
  const pb = await getPlaybook(CATEGORY)
  if (!pb) {
    console.error(`[update-faq] playbook ${CATEGORY} not found`)
    process.exit(1)
  }
  const faq = pb.faq ?? []
  const idx = faq.findIndex(
    (e) => e.question.trim().toLowerCase() === QUESTION_MATCH
  )
  if (idx === -1) {
    console.error(`[update-faq] FAQ entry not found — nothing changed`)
    process.exit(1)
  }
  if (faq[idx]!.answer.trim() === NEW_ANSWER) {
    console.log("[update-faq] already up to date — no change")
    process.exit(0)
  }
  const before = faq[idx]!.answer
  faq[idx] = { ...faq[idx]!, answer: NEW_ANSWER }
  await upsertPlaybook({ ...pb, faq })
  console.log("[update-faq] updated set-menu FAQ answer")
  console.log(`  was: ${before}`)
  console.log(`  now: ${NEW_ANSWER}`)
  process.exit(0)
}

void main()
