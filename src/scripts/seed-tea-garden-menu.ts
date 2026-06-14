// Seeds the full Tea Garden menu as an authoritative FAQ so the agent can
// answer menu / price / dietary questions accurately, and points the high-tea
// playbook at the menu PDF (dropped in ./attachments) as a default attachment.

import { getPlaybook, upsertPlaybook } from "../db/queries.js"

const MENU_Q = "What's on the Tea Garden menu? (prices, dietary options)"

const MENU_A = `TARTE TEA GARDEN MENU (Currumbin). Hours: Wed-Fri 9am-2pm, Sat-Sun 7:30am-2:30pm (closed Mon-Tue). Table service or takeaway, order at the counter.

HIGH TEA — $55 per person (includes a hot or cold drink; add $2.50 for a cloud or hot chocolate).
  Sweet: speciality tartes; scones with fresh cream and Tarte's raspberry jam; brown butter choc chip cookie; muffin top (strawberry & white chocolate); croissant; crullers.
  Savoury: salmon bagel; cucumber sandwich; tomato bagel; chicken sandwich.
  (There is also a "Classic High Tea" version at the same $55pp with a slightly different selection, incl. berry tarte, plain scone, and a cheese croissant.)

A LA CARTE — gluten-free and dairy-free options available (gfo, dfo): Salmon Bagel $13; Cucumber Sandwich $9; Tomato Bagel $10; Chicken Sandwich $11.

PASTRY BAR: Classic Scone (jam & cream) $6.50; Brown Butter Choc Chip Cookie $4; Croissant $3; Muffin Top (strawberry, Lindt white choc) $5; Speciality Tartes $6; Cruller (vanilla bean & custard / cinnamon / dulce de leche) $4.

CLOUD DRINKS — $12 (Cookie Tiramisu $14, Classic Tiramisu $13): Blueberry Lavender, Candy Rhubarb, Clear Skies, The Storm, Iced Matcha, Iced Latte.

DRINKS: Batch Brew Coffee $6; Chai Latte $5; Matcha Latte $6; Iced Latte $6.50; Iced Matcha $8; French old-fashioned hot chocolate; Tarte Parisian Hot Chocolate with house marshmallow $8.90 (for two $9.90); Traditional Lemonade / Southern Iced Tea / Arnold Palmer $9.90; Orange or Watermelon Juice $9.90.

SPECIALITY TEA (served in a pot, $6): Orange Sky, Maple Walnut, Ginger Limoncello, Pearl, Strawberry Plum, Vanilla Sencha, French Earl Grey, New York Breakfast, Strawberries & Cream, Tarte Brownie Cookie, Sticky Chai, English Breakfast.

WINE & BUBBLES: Prosecco (Fierce III) $16/$75; Champagne (Veuve Clicquot $29/$140, Tattinger Brut $135); Rosé (Rameau d'Or) $15/$70; Sauv Blanc (Craggy Range) $16/$75; Pinot Gris $14/$66; Papa Salt Gin cocktails; Mimosa $16; Aperol Spritz $17. Bottled beers $10-$13 (Stone & Wood, Peroni, Great Northern, Balter, Corona; non-alc available).

When asked about dietaries: the a la carte savoury items have gluten-free and dairy-free options. For anything else, we can usually accommodate with notice, but we're not a fully allergen-free kitchen so we can't guarantee no trace cross-contamination.`

async function main(): Promise<void> {
  const cats = [
    "general_enquiries",
    "events_tea_garden_high_tea",
    "bookings_dine_in",
    "orders_bespoke",
  ]
  for (const cat of cats) {
    const p = await getPlaybook(cat)
    if (!p) {
      console.log(`skip (no playbook): ${cat}`)
      continue
    }
    const existing = p.faq.find((f) => f.question === MENU_Q)
    if (existing) existing.answer = MENU_A
    else p.faq.push({ question: MENU_Q, answer: MENU_A })
    // High-tea replies attach the menu PDF on first reply.
    if (cat === "events_tea_garden_high_tea") {
      const paths = new Set(p.default_attachment_paths ?? [])
      paths.add("tea-garden-menu.pdf")
      p.default_attachment_paths = [...paths]
    }
    await upsertPlaybook(p)
    console.log(`seeded menu FAQ -> ${cat}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
