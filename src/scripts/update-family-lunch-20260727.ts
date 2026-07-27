// One-off: bring the LIVE events_beach_house_functions FAQ in line with the
// current Hideout Family Style Lunch menu (Chloe, 2026-07-27): crispy chilli &
// burrata / seasonal salad / spanner crab linguine / sauteed greens replace the
// old cured salmon / asian herb salad / chilli crab menu. Also drops the
// "upstairs" wording from the Hideout description (no upstairs/downstairs at
// Beach House). seed-faqs.ts never overwrites a non-empty live answer, so this
// targeted update is needed (same pattern as update-set-menus-20260720.ts).
//
// Idempotent — safe to run repeatedly.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/update-family-lunch-20260727.js

import { migrate } from "../db/pool.js"
import { getPlaybook, upsertPlaybook } from "../db/queries.js"

const CATEGORY = "events_beach_house_functions"

const LUNCH_Q = "hideout family style lunch package?"
const LUNCH_A =
  "$89 per person. 3 hours including setup. Start time 11am-2pm. Min 12, max 32 seated. Includes crispy chilli and burrata, fresh sourdough with olive oil, seasonal salad, spanner crab linguine, sauteed greens, and seasonal berry tarte for dessert. Beer, wine or cocktail each."

const HIDEOUT_Q = "what is the hideout?"

async function main(): Promise<void> {
  await migrate()
  const pb = await getPlaybook(CATEGORY)
  if (!pb) {
    console.error(`[update-family-lunch] playbook ${CATEGORY} not found`)
    process.exit(1)
  }
  const faq = [...(pb.faq ?? [])]
  const norm = (s: string): string => s.trim().toLowerCase()
  let changed = 0

  // 1. Family Style Lunch: update the answer in place (insert if missing).
  const lIdx = faq.findIndex((e) => norm(e.question) === LUNCH_Q)
  if (lIdx === -1) {
    faq.push({ question: "Hideout Family Style Lunch package?", answer: LUNCH_A })
    changed++
  } else if (faq[lIdx]!.answer.trim() !== LUNCH_A) {
    faq[lIdx] = { ...faq[lIdx]!, answer: LUNCH_A }
    changed++
  }

  // 2. Hideout description: drop "upstairs" (no upstairs/downstairs exists).
  const hIdx = faq.findIndex((e) => norm(e.question) === HIDEOUT_Q)
  if (hIdx !== -1 && /\bupstairs\b/i.test(faq[hIdx]!.answer)) {
    faq[hIdx] = {
      ...faq[hIdx]!,
      answer: faq[hIdx]!.answer.replace(/ upstairs\b/gi, ""),
    }
    changed++
  }

  if (!changed) {
    console.log("[update-family-lunch] already up to date — no change")
    process.exit(0)
  }
  await upsertPlaybook({ ...pb, faq })
  console.log(`[update-family-lunch] applied ${changed} FAQ change(s):`)
  console.log(`  lunch -> ${LUNCH_A}`)
  process.exit(0)
}

void main()
