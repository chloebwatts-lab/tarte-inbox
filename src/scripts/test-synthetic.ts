// Synthetic classification + drafting smoke test. Feeds fabricated customer
// emails through the live classifier/drafter (in-memory only — no Gmail, no
// DB writes) so prompt changes can be verified without real threads.
//
//   docker compose exec inbox node dist/scripts/test-synthetic.js

import { classify } from "../llm/classifier.js"
import { draft } from "../llm/drafter.js"
import { getPlaybook } from "../db/queries.js"
import { maybeAllergenBlock } from "../tk/allergens.js"

const CASES = [
  {
    name: "dinner enquiry",
    from: "Sophie Miller <sophie.m@gmail.com>",
    subject: "Dinner bookings?",
    body: "Hi! Are you open for dinner on Friday nights? Would love to come with my partner for an evening meal. Thanks, Sophie",
  },
  {
    name: "existing booking change",
    from: "Mark Chen <mark.chen@outlook.com>",
    subject: "Re: Booking confirmation",
    body: "Hi, we have a booking for 4 this Saturday at 11am but need to push it to 12:30 if possible, and one of us is now gluten free. Can you help? Mark",
  },
  {
    name: "cake order",
    from: "Lisa Pham <lisa.pham@gmail.com>",
    subject: "Birthday cake",
    body: "Hello, I'd love to order a birthday cake for my daughter's 5th birthday on the 28th of June. Around 20 serves. Do you do custom cakes?",
  },
  {
    name: "gluten-free question",
    from: "Emma Wright <emma.wright@gmail.com>",
    subject: "Gluten free options?",
    body: "Hi there, my mum is coeliac and we're hoping to come in for lunch next week. Do you have gluten free options? What can she safely eat? Thanks!",
  },
  {
    name: "dairy-free pastry order",
    from: "Tom Riley <tom.riley@gmail.com>",
    subject: "Dairy free pastries",
    body: "Hey, are any of your pastries dairy free? My son has a milk allergy and I'd love to grab him something on Saturday.",
  },
  {
    name: "food safety (urgent)",
    from: "Greg Holt <greg.holt@bigpond.com>",
    subject: "Unwell after visiting",
    body: "I ate at your cafe yesterday and have been violently ill since last night. I think it was the chicken sandwich. I want to know what you're going to do about this.",
  },
  {
    name: "evening function ask",
    from: "Priya Nair <priya.nair@gmail.com>",
    subject: "Evening engagement party?",
    body: "Hi! We're looking at an engagement party for about 25 people, ideally a Friday or Saturday evening around 7pm sometime in September. Do you host evening events? What would it cost?",
  },
  {
    name: "huge group",
    from: "Dave Connor <dave.connor@company.com.au>",
    subject: "Christmas party for 80",
    body: "Hi, our company is looking for a venue for our end of year party, around 80 people, sometime in early December. Can you accommodate us?",
  },
  {
    name: "where are you / dogs / parking",
    from: "Sue Ellen <sue.ellen@gmail.com>",
    subject: "Quick questions",
    body: "Hi! Where exactly are you located? Is there parking nearby and can I bring my dog? Also are you open Mondays?",
  },
]

async function main(): Promise<void> {
  for (const c of CASES) {
    const r = await classify(c.subject, c.from, c.body)
    console.log("\n" + "═".repeat(70))
    console.log(`CASE: ${c.name}`)
    console.log(`→ category=${r.category} confidence=${r.confidence.toFixed(2)}`)
    const noDraft = ["urgent_escalation", "no_action", "needs_human", "marketing_cold_outreach", "accounts_invoices"]
    if (noDraft.includes(r.category)) {
      console.log("(no draft for this category — label/flag only)")
      continue
    }
    const playbook = await getPlaybook(r.category)
    // Mirror the pipeline: dietary mentions pull in the TK allergen matrix.
    const allergenBlock = await maybeAllergenBlock(c.subject + "\n" + c.body)
    const d = await draft({
      category: r.category,
      playbook,
      threadHistory: [{ from: c.from, date: new Date(), text: c.body }],
      customerName: c.from.split(" ")[0],
      customExtras: allergenBlock
        ? [{ role: "user", content: allergenBlock }]
        : undefined,
    })
    console.log(`DRAFT (confidence ${d.confidence.toFixed(2)}${d.flags.length ? ", flags: " + d.flags.join("/") : ""}):`)
    console.log(d.body)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
