// ONE source of truth for what we sell, where, and for how much.
//
// Why this file exists (audit 12 Nov 2026): package facts used to live in
// three places that drifted apart: the drafter's BUSINESS_FACTS, hardcoded
// strings in pipeline.ts, and per-category playbook FAQs in the database.
// A follow-up email classified as "bookings_existing" got NONE of the function
// FAQs, so the agent made prices up ("$55pp is all-inclusive of venue hire",
// "the $55 high tea can be booked in the Hideout"), and the restaurant set
// menus were offered to every Tea Garden enquiry.
//
// This block goes into EVERY customer draft, whatever the category. To change
// a price, change it here and nowhere else.

/** Restaurant set menus (functions pack, "The Restaurant - Shared Dining Room"). */
// Chloe confirmed $55 on 12 Nov 2026 (the functions pack PDF still prints $45
// until it is reissued).
export const RESTAURANT_SET_BRUNCH = 55
export const RESTAURANT_SET_LUNCH = 65
/** Hideout packages (functions pack, "The Hideout - Private Room"). */
export const HIDEOUT_HIGH_TEA = 89
export const HIDEOUT_FAMILY_LUNCH = 89

// Chloe, 12 Nov 2026: when the Hideout is already booked on the customer's
// date we now offer these in the Tea Garden instead. The restaurant set menus
// are $5 less there, and the Hideout family style lunch is $79pp.
export const TG_SET_MENU_DISCOUNT = 5
// The Tea Garden set brunch price is NOT published to the drafter yet: Chloe
// quoted the restaurant brunch as $55 on 12 Nov, while the functions pack and
// the team's sent emails say $45. Until she confirms which, the drafter offers
// the brunch without a figure and a teammate adds the price. To switch it on,
// set TG_SET_BRUNCH_CONFIRMED to true (and fix RESTAURANT_SET_BRUNCH if it
// really is $55).
export const TG_SET_BRUNCH_CONFIRMED: boolean = true
export const TG_SET_BRUNCH = RESTAURANT_SET_BRUNCH - TG_SET_MENU_DISCOUNT
const TG_BRUNCH_LINE = TG_SET_BRUNCH_CONFIRMED
  ? `$${TG_SET_BRUNCH}pp`
  : `(price being confirmed: you may mention that a set brunch is also possible in the Tea Garden, with NO dollar figure, and say we will confirm the brunch price)`
export const TG_SET_LUNCH = RESTAURANT_SET_LUNCH - TG_SET_MENU_DISCOUNT
export const TG_FAMILY_LUNCH = 79

export const PACKAGES_BLOCK = `PACKAGES BY SPACE (authoritative; overrides anything else you have been told about prices).
Every package belongs to ONE space. Never offer a package in a space it is not listed under, never move a price from one space to another, and never state a price that is not written here, in the cheat sheet, or already quoted by us in the thread. If a price or inclusion is not here, leave it out and add "needs_human".
The category label on this email is only a routing guess. Work out which space the customer means from what they actually asked for. If it is unclear, ask them.

1. THE RESTAURANT (Beach House main dining room, a shared space). Table bookings only, never private.
   - Up to 11 guests: regular menu, book on the website. No deposit.
   - 12 to 16 guests (16 is the maximum for a restaurant table): a set menu is required Friday, Saturday and Sunday. Monday to Thursday they can order from the regular menu.
     - Set Brunch $${RESTAURANT_SET_BRUNCH}pp
     - Set Lunch $${RESTAURANT_SET_LUNCH}pp
   - No deposit and no hire fee for a table booking. More than 16 is by special request only (add "needs_human").
   - These set menus are RESTAURANT ONLY. The one exception is section 4.

2. THE HIDEOUT (private function room at the Beach House, exclusive use, 3 hours including set up, minimum 12, up to 32 seated).
   - Hideout High Tea $${HIDEOUT_HIGH_TEA}pp (start 10am to 2pm)
   - Hideout Family Style Lunch $${HIDEOUT_FAMILY_LUNCH}pp (start 11am to 2pm). Optional add-ons: charcuterie starter +$10pp, steak and frites +$22pp. Children on the Family Style Lunch only: kids lunch $45 per child (there is no kids price for the Hideout High Tea).
   - Unlimited drinks package +$30pp (all guests must take it), otherwise drinks on a tab.
   - Fewer than 12 guests can still book by covering the cost of 12.
   - Deposit: 50% of the package secures the date ($500 save-the-date if numbers or package are not final yet).
   - The private room is part of the $89. The $55 Tea Garden high tea is NOT available in the Hideout. There is no cheaper Hideout price.

3. THE TEA GARDEN (next door to the Beach House, open Wednesday to Sunday).
   - Standard high tea $55pp, no alcohol included, booked on the website like any table. Kids high tea $35 per child. Bottomless mimosas +$39pp for 75 minutes from 10am.
   - Make it private: +$500 for a private section (up to 24 seated outside), or +$1,000 for exclusive use inside and out. This is added to the per person price.
   - WHOLE VENUE HIRE (minimum 30 guests, up to 80 standing, $2,000 refundable bond, 50% deposit): a venue hire fee PLUS a per person package. The hire fee is $1,500 for 3 hours within trading hours, or $1,000 for 3 hours after 2pm, $300 per extra hour. Packages on top: High Tea with a beer and prosecco each $55pp, or High Tea + Canapes + Cocktails + Beer and Prosecco $90pp. Unlimited drinks +$30pp. The per person price NEVER includes the hire fee.
   - The restaurant set menus and the Hideout lunch are NOT Tea Garden packages. The one exception is section 4.

4. TEA GARDEN WHEN THE HIDEOUT IS ALREADY BOOKED (new from 12 November 2026).
   Applies ONLY when the "Calendar check" for this email says the Hideout is taken or held on the customer's date. Then, instead of turning the group away, offer the same food in the Tea Garden at these prices:
     - Set Brunch in the Tea Garden ${TG_BRUNCH_LINE}
     - Set Lunch in the Tea Garden $${TG_SET_LUNCH}pp
     - Family Style Lunch in the Tea Garden $${TG_FAMILY_LUNCH}pp
   Say plainly that the Hideout is already booked that day and that we can host them in the Tea Garden instead, name the option(s) that fit with the price, and add "needs_human". Quote these prices as they are: do not add a private section fee, hire fee, deposit or any other extra to them, and do not swap in the Tea Garden high tea prices. A teammate confirms the set up. If there is no Calendar check, or it does not say the Hideout is taken, these three prices do not exist: do not mention them.`

/** Every dollar figure the block above legitimately contains. */
export function packageAmounts(): Set<string> {
  return amountsIn(PACKAGES_BLOCK)
}

/** Dollar amounts in a text, normalised: "$1,500.00" and "$ 1500" → "1500". */
export function amountsIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/\$\s?(\d[\d,]*)(?:\.(\d{1,2}))?/g)) {
    const whole = m[1]!.replace(/,/g, "")
    const cents = m[2] && Number(m[2]) > 0 ? "." + m[2].padEnd(2, "0") : ""
    out.add(String(Number(whole)) + cents)
  }
  return out
}
