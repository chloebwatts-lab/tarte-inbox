import { anthropic, MODEL } from "./client.js"

export const CATEGORIES = [
  "events_tea_garden_high_tea",
  "events_tea_garden_functions",
  "events_beach_house_functions",
  "suppliers",
  "reviews",
  "bookings_dine_in",
  "job_applications",
  "marketing_cold_outreach",
  "accounts_invoices",
  "needs_human",
] as const

export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  events_tea_garden_high_tea: "Events / Tea Garden - High Tea",
  events_tea_garden_functions: "Events / Tea Garden - Functions",
  events_beach_house_functions: "Events / Beach House - Functions",
  suppliers: "Suppliers",
  reviews: "Reviews",
  bookings_dine_in: "Bookings",
  job_applications: "Job applications",
  marketing_cold_outreach: "Marketing / Cold outreach",
  accounts_invoices: "Accounts / Invoices",
  needs_human: "Needs human",
}

const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  events_tea_garden_high_tea:
    "Enquiry about a high tea at Tea Garden, 12 pax or fewer. (Most arrive via Now Book It directly — if it lands by email, the agent should redirect to the booking widget.)",
  events_tea_garden_functions:
    "Function enquiry at Tea Garden for groups over 12 pax. Email-driven because floor layout needs human check.",
  events_beach_house_functions:
    "Function / event enquiry at Beach House. Email-driven, exclusive-use venue.",
  suppliers:
    "From a supplier — price changes, delivery issues, statements, invoices in body, product questions.",
  reviews:
    "Notification of a Google/Tripadvisor/Yelp review, or a customer feedback email.",
  bookings_dine_in:
    "A regular dine-in reservation request. These should normally go through Now Book It — flag if landed in email.",
  job_applications: "A CV / job application / casual work enquiry.",
  marketing_cold_outreach:
    "Unsolicited sales pitch, agency outreach, SEO/marketing pitch, cold B2B offer.",
  accounts_invoices:
    "Invoices to pay, bills, statements, accounting matters destined for the accounts team.",
  needs_human:
    "Doesn't fit other categories or is ambiguous / sensitive. Default for low confidence.",
}

export interface ClassificationResult {
  category: Category
  confidence: number
  rationale: string
}

const SYSTEM = `You triage emails for Tarte, a hospitality business in Queensland, Australia, with two venues: a Tea Garden (high teas + functions) and a Beach House (event functions). The mailbox is hello@tarte.com.au.

You return STRICT JSON only — no prose, no markdown. Shape:
{ "category": "<one of the keys below>", "confidence": <0..1>, "rationale": "<one short sentence>" }

Categories:
${(Object.keys(CATEGORY_DESCRIPTIONS) as Category[])
  .map((k) => `- ${k}: ${CATEGORY_DESCRIPTIONS[k]}`)
  .join("\n")}

Rules:
- If the email is a function/event enquiry mentioning a number over 12 → tea_garden_functions; under or unspecified for high tea → tea_garden_high_tea.
- Beach House mentions or beach-side venue references → events_beach_house_functions.
- Review notification emails from Google / Tripadvisor / Yelp / etc → reviews.
- Pitch / agency / SEO / cold offer → marketing_cold_outreach. Be liberal here; default these to low-priority.
- When in doubt, prefer needs_human over a wrong confident answer.
- Confidence under 0.6 → also coerce category to needs_human.`

export async function classify(
  subject: string,
  fromAddr: string,
  bodyText: string
): Promise<ClassificationResult> {
  const trimmed = bodyText.slice(0, 6000)
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 256,
    system: [
      {
        type: "text",
        text: SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `From: ${fromAddr}\nSubject: ${subject}\n\n${trimmed}`,
      },
    ],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") {
    return {
      category: "needs_human",
      confidence: 0,
      rationale: "no text from model",
    }
  }
  return parseJson(block.text)
}

function parseJson(text: string): ClassificationResult {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    return {
      category: "needs_human",
      confidence: 0,
      rationale: `unparseable: ${text.slice(0, 80)}`,
    }
  }
  try {
    const obj = JSON.parse(match[0]) as Partial<ClassificationResult>
    const cat = obj.category as Category | undefined
    const conf = typeof obj.confidence === "number" ? obj.confidence : 0
    const safeCat: Category =
      cat && (CATEGORIES as readonly string[]).includes(cat)
        ? cat
        : "needs_human"
    return {
      category: conf < 0.6 ? "needs_human" : safeCat,
      confidence: conf,
      rationale: obj.rationale ?? "",
    }
  } catch {
    return {
      category: "needs_human",
      confidence: 0,
      rationale: "json parse failed",
    }
  }
}
