// Pre-populates the FAQ / cheat sheet on each playbook with facts extracted
// from the functions & events package PDF (run 2026-05-29), plus a set of
// "needs answer" questions that the agent commonly gets asked but doesn't
// have an answer for. Shawna / Chloe can fill these in via the admin UI.
//
// Idempotent: an existing FAQ with the same question is overwritten only
// when the new answer is non-empty. Questions Shawna has already answered
// in the admin UI are preserved.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/seed-faqs.js

import { migrate } from "../db/pool.js"
import { getPlaybook, upsertPlaybook } from "../db/queries.js"

interface FaqSeed {
  category: string
  faq: Array<{ question: string; answer: string }>
}

const SEEDS: FaqSeed[] = [
  {
    category: "events_tea_garden_high_tea",
    faq: [
      {
        question: "How much is a standard Tea Garden high tea?",
        answer:
          "$55 per person. 90 minute sitting, Wed-Sun from 9am. Book directly via the website (Now Book It).",
      },
      {
        question: "What's included in the Tea Garden high tea?",
        answer:
          "Hot or cold drink of choice, mini pastries, mini bagels, croissants, chicken sandwiches, and scones with jam and cream. Cloud range drinks and hot chocolate are an extra $2.50 each.",
      },
      {
        question:
          "Can we make the Tea Garden high tea a private event for a small group?",
        answer:
          "Yes. Additional $500 to make the seated outdoor area private (up to 24 guests). Additional $1000 for exclusive hire of the entire venue (inside and out).",
      },
      {
        question: "How long does the Tea Garden high tea go for?",
        answer: "90 minute sitting.",
      },
      {
        question: "What days/hours can we book a Tea Garden high tea?",
        answer: "Wed to Sun, sittings from 9am.",
      },
      {
        question: "How much is a kids high tea?",
        answer: "",
      },
      {
        question: "What does a kids high tea include?",
        answer: "",
      },
      {
        question: "Do you cater for allergies and dietaries?",
        answer:
          "Yes, dietaries and intolerances can be accommodated for an extra per-head fee. Charges are outlined before invoicing.",
      },
    ],
  },
  {
    category: "events_tea_garden_functions",
    faq: [
      {
        question: "Tea Garden whole venue hire packages?",
        answer:
          "Three options:\n- High Tea + Beer + Prosecco: $55 per person\n- High Tea + Canapes + Cocktails + Beer + Prosecco: $90 per person\n- Add unlimited drinks package: +$30 per person\nOr hire the space with no inclusions: $1000 for 3 hours after 2pm, $1500 within trading hours, $300 per additional hour.",
      },
      {
        question: "Tea Garden function group sizes?",
        answer:
          "Minimum 30 guests, maximum 80 standing. Earliest start 2pm, finish by 8pm.",
      },
      {
        question: "Is there a bond on Tea Garden whole venue hire?",
        answer: "Yes, $2000 refundable bond applies.",
      },
      {
        question: "Can we bring our own florals, music, props for a function?",
        answer:
          "Yes for Tea Garden whole venue hire - you're welcome to bring in your own florals, props, musicians and signage.",
      },
      {
        question: "Deposit and cancellation policy?",
        answer:
          "50% deposit secures your function date. There is a 2 week cancellation grace period - the deposit is non-refundable within 2 weeks of the event. Confirmation of additional guests is required 48 hours prior. All prices include GST.",
      },
      {
        question: "Can we bring our own cake / food / drinks?",
        answer:
          "No - we don't accept outside food, drinks or cake due to health and safety / council regulations.",
      },
    ],
  },
  {
    category: "events_beach_house_functions",
    faq: [
      {
        question: "What is The Hideout?",
        answer:
          "The Hideout is our private function space upstairs at Beach House. Relaxed Parisian-Hamptons styling, sweeping views of Currumbin Creek and a 100-year-old fig tree. Intimate gatherings of 12-30 guests. Private balcony, air-conditioned, dedicated staff.",
      },
      {
        question: "Hideout High Tea package price and inclusions?",
        answer:
          "$89 per person. 3 hours including setup. Start time 10am-2pm. Min 12, max 32 seated. Includes mini pastries, mini bagels, croissants, chicken sandwiches, scones with jam and cream, coffee and tea, and a free glass of sparkling, wine or mocktail. Add-on drinks tab available.",
      },
      {
        question: "Hideout Family Style Lunch package?",
        answer:
          "$89 per person. 3 hours including setup. Start time 11am-2pm. Min 12, max 32 seated. Includes cured salmon, fresh sourdough with olive oil, asian herb micro green salad, chilli crab linguine, greens, and seasonal berry tarte for dessert. Beer, wine or cocktail each.",
      },
      {
        question: "Minimum party size for a Hideout function?",
        answer:
          "Minimum party of 12. If you have a smaller group, you can still book by covering the minimum cost for 12 pax.",
      },
      {
        question: "Hideout maximum capacity?",
        answer:
          "32 seated guests for both High Tea and Family Style Lunch packages.",
      },
      {
        question: "Deposit and cancellation policy?",
        answer:
          "50% deposit secures your function date. 2 week cancellation grace period - non-refundable within 2 weeks of the event. Confirmation of additional guests is required 48 hours prior. All prices include GST.",
      },
      {
        question: "Can we decorate The Hideout ourselves?",
        answer:
          "Yes - the space is yours to decorate. No outside food, drinks or cake though (health and safety / council regulations).",
      },
      {
        question: "Are dietaries accommodated for functions?",
        answer:
          "Yes - dietaries and intolerances can be accommodated for an extra per-head fee. Charges are outlined before invoicing.",
      },
      {
        question:
          "Are extra beverages on the day included or extra?",
        answer:
          "Extra beverages charged on consumption must be paid the day of the function.",
      },
    ],
  },
  {
    category: "bookings_dine_in",
    faq: [
      {
        question: "Do the cafes take bookings?",
        answer:
          "No - both cafes (Tarte Bakery & Cafe at Burleigh and the cafe downstairs at Currumbin Beach House) are walk-in only. Tea Garden high teas and Beach House restaurant bookings go through Now Book It.",
      },
      {
        question: "Set Brunch Package at Beach House restaurant?",
        answer:
          "$40 per person. 6-16 pax, 2-hour sitting. Choice of main dish (avo toast, salmon bagel, eggs your way with a side), fresh juice, coffee or tea.",
      },
      {
        question:
          "What does the $55 set restaurant brunch include?",
        answer:
          "$55 per person. Yoghurt pot, choice of main (avo toast / salmon bagel / eggs your way with a side), selection of pastries, fresh juice, coffee or tea. 6-16 pax, 2-hour sitting.",
      },
      {
        question:
          "Do groups over 12 in the restaurant need a set menu?",
        answer:
          "Yes - groups of more than 12 dining in the restaurant on weekends are required to go with a set menu. This helps deliver a smooth service for the group and other patrons during peak service times.",
      },
    ],
  },
  {
    category: "reviews",
    faq: [],
  },
  {
    category: "suppliers",
    faq: [],
  },
]

async function main(): Promise<void> {
  await migrate()
  for (const seed of SEEDS) {
    const pb = await getPlaybook(seed.category)
    if (!pb) {
      console.log(`[seed-faqs] ${seed.category}: not found, skipping`)
      continue
    }
    const existing = pb.faq ?? []
    const merged = [...existing]
    let added = 0
    let kept = 0
    for (const newEntry of seed.faq) {
      const match = merged.findIndex(
        (e) => e.question.trim().toLowerCase() === newEntry.question.trim().toLowerCase()
      )
      if (match === -1) {
        merged.push(newEntry)
        added++
      } else {
        // Keep the human's answer if they've already filled it in.
        if (merged[match]!.answer.trim()) {
          kept++
        } else {
          merged[match] = newEntry
          added++
        }
      }
    }
    await upsertPlaybook({ ...pb, faq: merged })
    console.log(
      `[seed-faqs] ${seed.category}: total ${merged.length} (added/refreshed ${added}, kept-human-answer ${kept})`
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
