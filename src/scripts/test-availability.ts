// Offline checks for the calendar reading and draft guards (no Google, no LLM).
//   npm run build && node dist/scripts/test-availability.js

import {
  classifySpace,
  isIgnorable,
  renderAvailability,
  datesToCheck,
  claimsAvailability,
  type DayPicture,
} from "../availability.js"
import { ownership } from "../availability.js"
import { guardDraft } from "../llm/drafter.js"
import { amountsIn, PACKAGES_BLOCK, TG_SET_BRUNCH_CONFIRMED, TG_SET_LUNCH, TG_FAMILY_LUNCH } from "../llm/packages.js"

let failed = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
  if (!ok) failed++
}

// Titles are the shapes the team really types on the calendar.
check("hideout title", classifySpace("Hideout 17 pax lunch TBC") === "hideout")
check("hide out title", classifySpace("PAT HIDE OUT HIGH TEA 17PAX") === "hideout")
check("TG title", classifySpace("TG whole venue hire enquiry") === "tea_garden")
check("tea garden title", classifySpace("Tea Garden private section 20pax") === "tea_garden")
check("other title", classifySpace("Kim L TBC 40pax 2-5pm baby shower") === "other")
check("gmail reservation card ignored", isIgnorable("Reservation at Tarte Beach House, Currumbin"))
check("fromGmail ignored", isIgnorable("anything", "fromGmail"))
check("cancelled ignored", isIgnorable("CANCELLED Hideout high tea"))
check("real function kept", !isIgnorable("Hideout High Tea deposit sent"))

const taken: DayPicture = {
  date: "2026-12-06",
  hideoutTaken: true,
  entries: [
    { space: "hideout", timeLabel: "all day", tentative: false, summary: "x hideout lunch" },
    { space: "other", timeLabel: "1:00pm - 2:00pm", tentative: true, summary: "TBC 40pax baby shower" },
  ],
}
const empty: DayPicture = { date: "2026-11-28", hideoutTaken: false, entries: [] }
const takenTxt = renderAvailability([taken])
const emptyTxt = renderAvailability([empty])
check("taken day says Hideout not available", /Hideout is NOT available this day/.test(takenTxt))
check("taken day never leaks a customer name for hideout", !/x hideout lunch/.test(takenTxt))
check("empty day is NOT called free", /does NOT mean the date is free/.test(emptyTxt))
check("empty day does not unlock section 4", !/Hideout is NOT available/.test(emptyTxt))
check("weekday computed from the date string", /Sunday 6 December 2026/.test(takenTxt))
check("unreadable calendar is reported", /COULD NOT BE READ/.test(renderAvailability([], ["2026-12-01"])))

check(
  "every named date is checked",
  datesToCheck({
    preferred_date: null,
    date_range_start: null,
    date_range_end: null,
    weekends_only: false,
    dates_mentioned: ["2027-03-20", "2027-02-06", "2027-03-27"],
  }).length === 3
)
check(
  "weekend range expands to Sat + Sun",
  datesToCheck({
    preferred_date: null,
    date_range_start: "2027-01-04",
    date_range_end: "2027-01-10",
    weekends_only: true,
  }).join() === "2027-01-09,2027-01-10"
)

for (const s of [
  "Saturday 5th December at 11am is looking open on our end",
  "Sunday the 25th at 10:00am looks open",
  "both are looking good from our end",
  "Sunday 6th December at 9:00am works well for us",
  "a 9:00am start works well",
  "A 10:00am start looks workable",
  "the Hideout is available on that date",
  "I have gone ahead and booked you in",
]) check(`claim caught: ${s.slice(0, 40)}`, claimsAvailability(s))
for (const s of [
  "The Tea Garden is open Wednesday to Sunday.",
  "I would be more than happy to check availability and get something booked in for you.",
  "Unfortunately the Hideout is already booked that day.",
]) check(`not a claim: ${s.slice(0, 40)}`, !claimsAvailability(s))

check("own booking recognised by full name", ownership("Deposit Inv sent Hideout High tea Alex Rivers", ["Alex Rivers"]) === "yes")
check("first name only is a maybe", ownership("Robin hideout lunch 80th birthday", ["Robin Brown"]) === "maybe")
check("someone else's booking is not own", ownership("Jo Marsh Hideout High tea 15-20pax", ["Alex Rivers"]) === undefined)
check("short common surname alone is not enough", ownership("Long lunch Hideout", ["Sam Long"]) === undefined)
const ownDay = renderAvailability([
  { date: "2027-01-10", hideoutTaken: false, entries: [{ space: "hideout", timeLabel: "all day", tentative: false, summary: "x", own: "yes" }] },
])
check("own booking does not read as taken", /THIS CUSTOMER'S OWN booking/.test(ownDay) && !/Hideout is NOT available/.test(ownDay))

check("amounts normalise", [...amountsIn("$1,500 and $ 89.00 and $7pp")].join() === "1500,89,7")
check(
  "new Tea Garden prices are in the block",
  [TG_SET_LUNCH, TG_FAMILY_LUNCH].every((n) => PACKAGES_BLOCK.includes(`$${n}pp`))
)
check(
  "unconfirmed Tea Garden brunch price is not published",
  TG_SET_BRUNCH_CONFIRMED || !/Set Brunch in the Tea Garden \$/.test(PACKAGES_BLOCK)
)

const base = { confidence: 0.8, flags: [] as string[] }
const g1 = guardDraft({ ...base, body: "The Hideout high tea is $75pp." }, { knownText: PACKAGES_BLOCK, calendarBlock: "" })
check("invented price flagged", g1.flags.includes("unverified_price") && g1.flags.includes("needs_human"))
const g2 = guardDraft({ ...base, body: "The Hideout high tea is $89pp." }, { knownText: PACKAGES_BLOCK, calendarBlock: "" })
check("real price passes", g2.flags.length === 0)
const g3 = guardDraft(
  { ...base, body: "In the Tea Garden we can do the Set Lunch at $60pp." },
  { knownText: PACKAGES_BLOCK, calendarBlock: emptyTxt }
)
check("Tea Garden set menu flagged when Hideout is not booked", g3.flags.includes("check_package_matches_space"))
const g4 = guardDraft(
  { ...base, body: "The Hideout is booked that day, but in the Tea Garden we can do the Set Lunch at $60pp." },
  { knownText: PACKAGES_BLOCK, calendarBlock: takenTxt }
)
check("Tea Garden set menu allowed when Hideout is booked", !g4.flags.includes("check_package_matches_space"))
const g5 = guardDraft({ ...base, body: "Saturday looks open on our end." }, { knownText: PACKAGES_BLOCK, calendarBlock: "" })
check("availability claim flagged", g5.flags.includes("check_calendar_before_sending"))

console.log(failed ? `\n${failed} FAILED` : "\nall passed")
process.exit(failed ? 1 : 0)
