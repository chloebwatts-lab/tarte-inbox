// FAQ enrichment sweep (2026-06-12, Chris: "add as many FAQs as you want").
// Every non-empty answer here is sourced from verified material: the live
// tarte.com.au site, staff-written FAQ entries elsewhere in the playbooks,
// or rules Chris stated directly. Unknown facts are seeded as EMPTY answers
// so they surface in the TK admin for staff to fill — the drafter never
// sees empty answers.

import { getPlaybook, upsertPlaybook, type Playbook } from "../db/queries.js"

const BOOKING_URL =
  "https://bookings.nowbookit.com/?accountid=06af68f7-183b-467c-8157-953d162e74a0&venueid=12632"

function setAnswer(p: Playbook, question: string, answer: string): void {
  const f = p.faq.find((x) => x.question === question)
  if (!f) {
    p.faq.push({ question, answer })
    return
  }
  // Never blank an answer staff already wrote; only fill or replace with
  // non-empty content.
  if (answer) f.answer = answer
}

/** Adds an empty staff-prompt question only if it doesn't exist yet. */
function seedQuestion(p: Playbook, question: string): void {
  if (!p.faq.some((x) => x.question === question)) {
    p.faq.push({ question, answer: "" })
  }
}

async function main(): Promise<void> {
  // ---------- general_enquiries ----------
  const ge = await getPlaybook("general_enquiries")
  if (!ge) throw new Error("missing general_enquiries")

  setAnswer(
    ge,
    "Where are you located?",
    `We have two homes:
- Tarte Bakery & Cafe — 2 West Street, Burleigh Heads QLD 4220 (walk-in only).
- Tarte Beach House — Shop 1, 2-4 Thrower Drive, Currumbin QLD 4223. The restaurant is upstairs (bookable), the cafe downstairs is walk-in only, our Tea Garden is the lush space next door, and The Hideout is our private function room upstairs.`
  )
  setAnswer(
    ge,
    "How do I make a booking?",
    `Both cafes are walk-in only, no booking needed. The Beach House restaurant and Tea Garden high teas can be booked online here: ${BOOKING_URL} — bookings are recommended for high tea. For functions and private events, just reply to this email with your date, numbers and occasion.`
  )
  setAnswer(
    ge,
    "What are your opening hours?",
    `The Tea Garden is open Wed-Fri 9am-2pm and Sat-Sun 7:30am-2:30pm (closed Mon-Tue). For current cafe and restaurant hours at Burleigh and Currumbin, the most up-to-date times are on tarte.com.au and our Google listings.`
  )
  setAnswer(
    ge,
    "Are dogs allowed?",
    `Yes — all our spaces are dog-friendly. We'd love to meet your pup.`
  )
  setAnswer(
    ge,
    "Where can we park?",
    `At Currumbin we have dedicated parking directly in front of the venue, plus a free local council carpark attached, and additional free parking a short walk away across the bridge and on surrounding streets. We recommend allowing extra time on weekends and during peak periods.`
  )
  setAnswer(
    ge,
    "Do you have gluten-free / vegan options?",
    `Yes — we can cater for most dietary requirements within reason, including gluten-free and vegan, and for high teas we offer dedicated GF/vegan versions with prior notice (not always a direct item-for-item swap). Please note we're not a certified allergen-free kitchen, so while we take real care, we can't guarantee zero cross-contamination.`
  )
  setAnswer(
    ge,
    "Can I hire a paddleboard / SUP?",
    `Yes — SUP hire runs daily from the Beach House at Currumbin. Details at tarte.com.au/sup-hire.`
  )
  setAnswer(
    ge,
    "Do you take cake or catering orders?",
    `Yes — everything comes from our in-house bakery and pastry team: custom cakes, signature tarts, large pies and catering. Reply with the date you need it, pickup location (Burleigh or Currumbin), how many serves, and any flavour direction, and we'll sort the rest.`
  )
  seedQuestion(ge, "Do you sell gift vouchers?")
  seedQuestion(ge, "Is there wheelchair access at each venue?")
  seedQuestion(ge, "Do you have wifi for customers?")
  seedQuestion(ge, "I left something behind — how does lost property work?")
  seedQuestion(
    ge,
    "What's the best phone number to call you on? (Burleigh and Currumbin)"
  )
  await upsertPlaybook(ge)
  console.log("enriched general_enquiries")

  // ---------- bookings_dine_in ----------
  const bd = await getPlaybook("bookings_dine_in")
  if (!bd) throw new Error("missing bookings_dine_in")
  setAnswer(
    bd,
    "How do I book a table?",
    `The Beach House restaurant (upstairs at Currumbin) takes bookings online: ${BOOKING_URL}. Both cafes (Burleigh, and downstairs at the Beach House) are walk-in only — just come on down. Tea Garden high teas book through the same link.`
  )
  setAnswer(
    bd,
    "Can you take a large group for dine-in?",
    `For larger groups the best experience is usually one of our function options — a private section of the Tea Garden, full venue hire, or The Hideout (our private room upstairs at the Beach House, 12-30 guests). Tell us your numbers and occasion and we'll point you at the right fit.`
  )
  // The live template URL fix (placeholder link existed before).
  bd.reply_template = `Hey {{first_name}},\n\nThanks for reaching out — easiest way to lock this in is our booking system, which shows live availability: ${BOOKING_URL}\n\nIf you'd prefer we book it for you, give us a date, time and number of guests and we'll sort it.\n\nKind Regards,\nTarte Management`
  await upsertPlaybook(bd)
  console.log("enriched bookings_dine_in")

  // ---------- bookings_existing ----------
  const be = await getPlaybook("bookings_existing")
  if (!be) throw new Error("missing bookings_existing")
  setAnswer(
    be,
    "How do I change or cancel my booking?",
    `Reply to this email with what you'd like changed (date, time or numbers) and we'll action it for you. You can also manage the booking via the link in your original confirmation email.`
  )
  setAnswer(
    be,
    "Do you have high chairs?",
    `Yes, we have high chairs available — let us know how many you need and we'll note it on the booking and set the table accordingly.`
  )
  be.voice_guidance +=
    " KEEP IT SHORT: answer exactly what they asked, one warm line, sign off. Do NOT recite their booking details (date/pax/dietaries) back at them unless they asked you to confirm something — staff trim this every time. When pointing them to self-serve, use the booking page link from the business facts."
  await upsertPlaybook(be)
  console.log("enriched bookings_existing")

  // ---------- orders_bespoke ----------
  const ob = await getPlaybook("orders_bespoke")
  if (!ob) throw new Error("missing orders_bespoke")
  setAnswer(
    ob,
    "Can we bring a custom cake you made to a booking at your venue?",
    `Yes — and it's the best way to do cake with us, since outside cakes generally aren't permitted. Order through our bakery (signature tarts, large pies, celebration cakes or individual desserts) and we'll have it ready at your table or function. If an outside cake has been approved for a private function, a $7 per person cakeage fee applies.`
  )
  seedQuestion(ob, "Do you make wedding cakes?")
  seedQuestion(ob, "Can you do gluten-free or vegan custom cakes?")
  seedQuestion(ob, "How far in advance do custom cakes need to be ordered?")
  seedQuestion(ob, "How do I pay for a cake/catering order?")
  seedQuestion(ob, "Can cakes be picked up from either venue?")
  await upsertPlaybook(ob)
  console.log("enriched orders_bespoke")

  // ---------- events: evening question + template URL ----------
  for (const cat of [
    "events_tea_garden_functions",
    "events_beach_house_functions",
    "events_tea_garden_high_tea",
  ]) {
    const p = await getPlaybook(cat)
    if (!p) continue
    setAnswer(
      p,
      "Do you do evening functions?",
      `Not yet, but watch this space! Everything we do is daytime — though for private hire we do offer afternoon windows (e.g. Tea Garden whole-venue hire from 2pm). Functions wrap by late afternoon.`
    )
    if (cat === "events_tea_garden_high_tea" && p.reply_template) {
      p.reply_template = p.reply_template.replace(
        /https:\/\/nowbookit\.com\/\S*/,
        BOOKING_URL
      )
    }
    await upsertPlaybook(p)
    console.log(`enriched ${cat}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
