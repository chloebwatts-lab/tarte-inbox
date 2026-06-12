// One-off FAQ corrections (Chris, 2026-06-12):
// - Tea Garden private/exclusive events: venue hire fee is IN ADDITION to
//   the per-person package, and beer+prosecco at $55pp applies to private
//   events only (a standard high tea in normal service is $55 with no
//   alcohol included).
// - For groups of 12 or fewer, a regular website booking should be the
//   first suggestion (no hire fee) — private hire is the upgrade.
// - Cross-sell The Hideout ($89pp) on Tea Garden function enquiries.
// - Dinner FAQ must not imply evening functions exist — daytime only.
// - Strip the pasted-ChatGPT-transcript pollution from the high tea
//   BYO-cake answer.

import { getPlaybook, upsertPlaybook, type Playbook } from "../db/queries.js"

function setAnswer(p: Playbook, question: string, answer: string): void {
  const f = p.faq.find((x) => x.question === question)
  if (!f) {
    p.faq.push({ question, answer })
    return
  }
  f.answer = answer
}

async function main(): Promise<void> {
  // --- Tea Garden functions ---
  const tg = await getPlaybook("events_tea_garden_functions")
  if (!tg) throw new Error("missing tg functions playbook")

  setAnswer(
    tg,
    "Tea Garden whole venue hire packages?",
    `Our Tarte Tea Garden is available for whole venue private hire and is perfect for baby showers, hens parties, birthdays, brand events, workshops, high teas and intimate celebrations. The space is best suited to a mingling / standing-style event, with the option for guests to sit throughout the space.

IMPORTANT pricing structure for private / exclusive events: the venue hire fee and the per-person package are BOTH payable (the hire fee is in addition to the per-head cost, not instead of it).

Venue hire fee (private use of the whole Tea Garden, our styling and furniture in place):
- $1,500 for 3 hours within trading hours
- $1,000 for 3 hours after 2pm
- $300 per additional hour

Per-person packages (added on top of the hire fee):
- High Tea + Beer + Prosecco: $55 per person. Note the beer & prosecco inclusion at this price applies to PRIVATE EVENTS ONLY — a standard high tea during normal service is $55pp with no alcohol included.
- High Tea + Canapés + Cocktails + Beer + Prosecco: $90 per person.

Guests wanting a fully custom format (own catering, grazing tables, workshops, external suppliers) can take the venue hire with no per-person package, subject to approval.

All prices include GST.`
  )

  setAnswer(
    tg,
    "Is there a minimum spend for whole venue hire?",
    `For Tea Garden whole venue hire, the venue hire fee applies and any per-person package is in addition to it.

Venue hire fee:
- $1,500 for 3 hours within trading hours
- $1,000 for 3 hours after 2pm
- $300 per additional hour

Per-person packages on top of the hire fee: High Tea + Beer + Prosecco $55pp (beer & prosecco included for private events only), or High Tea + Canapés + Cocktails + Beer + Prosecco $90pp. Venue-hire-only (no inclusions) is available for custom event formats, subject to approval. All prices include GST.`
  )

  setAnswer(
    tg,
    "What about The Hideout at Beach House as an alternative?",
    `For groups of roughly 12-30 (up to 32 seated, ~40 standing), The Hideout — our private function space upstairs at Tarte Beach House — is often the easiest all-in option: $89 per person including 3 hours private use of the space, a high tea or family-style lunch package, and one drink on arrival. Private balcony, air-conditioning and Currumbin Creek views. Minimum 12 guests. Always worth offering alongside Tea Garden options when the group size fits.`
  )

  tg.voice_guidance +=
    " OPTIONS LADDER for Tea Garden groups: 12 or fewer → suggest a regular high tea booking through the website FIRST ($55pp standard, no hire fee); want privacy → +$500 private section (up to ~24-26 guests); full exclusivity → venue hire fee PLUS per-person package; groups 12-30 → also offer The Hideout at Beach House ($89pp all-in). When it's unclear whether they want private hire or just a table, ASK rather than assume."

  await upsertPlaybook(tg)
  console.log("updated events_tea_garden_functions")

  // --- Tea Garden high tea: clean polluted answer + suggest normal booking ---
  const ht = await getPlaybook("events_tea_garden_high_tea")
  if (!ht) throw new Error("missing high tea playbook")

  setAnswer(
    ht,
    "Can we BYO cake for a birthday high tea? Is there a cutting fee?",
    `Generally, outside cakes are not permitted, especially during normal service, due to health, safety and venue operations. Where possible, we recommend ordering dessert through our in-house bakery and pastry team — signature tarts, cakes, pies or individual desserts depending on the booking. If an outside cake is approved prior to the function, a cake-cutting / cakeage fee of $7 per person applies.`
  )

  ht.voice_guidance +=
    " For groups of 12 or fewer, the FIRST suggestion is a regular booking via the website ($55pp standard high tea, no hire fee). Private options (the $500 private section, full venue hire, or The Hideout at Beach House $89pp) are upgrades to offer when they want exclusivity."

  await upsertPlaybook(ht)
  console.log("updated events_tea_garden_high_tea")

  // --- General enquiries: dinner answer must not imply evening functions ---
  const ge = await getPlaybook("general_enquiries")
  if (!ge) throw new Error("missing general_enquiries playbook")
  setAnswer(
    ge,
    "Are you open for dinner?",
    `Not yet, but watch this space! For now everything we do is during the day — daytime dining, high tea, and private daytime functions at the Tea Garden and Beach House.`
  )
  await upsertPlaybook(ge)
  console.log("updated general_enquiries")
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
