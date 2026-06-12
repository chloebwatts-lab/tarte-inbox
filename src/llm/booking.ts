import { anthropic, MODEL } from "./client.js"

export interface BookingExtraction {
  pax: number | null
  preferred_date: string | null // YYYY-MM-DD — set when the customer named a specific day
  date_range_start: string | null // YYYY-MM-DD — earliest day they'd accept
  date_range_end: string | null // YYYY-MM-DD — latest day they'd accept
  weekends_only: boolean // true if they specifically asked for a weekend
  preferred_time: string | null // HH:MM 24h
  duration_hours: number | null
  customer_name: string | null
  notes: string | null
  confidence: number
}

const SYSTEM = `You read function/event enquiry emails for a Queensland hospitality business (Tarte). Extract booking details as STRICT JSON only:

{
  "pax": <int|null>,
  "preferred_date": "<YYYY-MM-DD|null>",
  "date_range_start": "<YYYY-MM-DD|null>",
  "date_range_end": "<YYYY-MM-DD|null>",
  "weekends_only": <true|false>,
  "preferred_time": "<HH:MM|null>",
  "duration_hours": <number|null>,
  "customer_name": "<string|null>",
  "notes": "<short summary string|null>",
  "confidence": <0..1>
}

Rules:
- Only fill fields you're reasonably sure about. Null is fine.
- Australian date format in source → convert to YYYY-MM-DD.
- If they named ONE specific day, use preferred_date and leave the range fields null.
- If they gave a RANGE — e.g. "last weekend in July or first weekend in August",
  "anytime in October", "between the 15th and 25th of March" — fill
  date_range_start + date_range_end (inclusive). Leave preferred_date null.
- "last weekend in July" → range Sat–Sun of that last weekend. "weekend" implies
  weekends_only=true.
- Resolve ALL relative dates ("next Saturday", "anytime in October", "the 15th")
  against the TODAY line at the top of the message. Resolved dates must be
  today or in the FUTURE — if a stated date has already passed, leave the date
  fields null and mention it in notes.
- Times in 24h. If only "lunch" / "dinner" mentioned, leave null.
- Customer name: their first name if extractable.`

function todayBrisbane(): { date: string; weekday: string } {
  const now = new Date()
  return {
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Brisbane",
    }).format(now),
    weekday: new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Brisbane",
      weekday: "long",
    }).format(now),
  }
}

export async function extractBooking(
  threadText: string
): Promise<BookingExtraction> {
  // Anchor relative dates — without this the model guesses the year and
  // "next Saturday" can resolve to the past.
  const today = todayBrisbane()
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 400,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `TODAY is ${today.weekday} ${today.date} (Australia/Brisbane).\n\n` +
          threadText.slice(0, 8000),
      },
    ],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") return empty()
  return parse(block.text)
}

function empty(): BookingExtraction {
  return {
    pax: null,
    preferred_date: null,
    date_range_start: null,
    date_range_end: null,
    weekends_only: false,
    preferred_time: null,
    duration_hours: null,
    customer_name: null,
    notes: null,
    confidence: 0,
  }
}

function parse(text: string): BookingExtraction {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return empty()
  try {
    const obj = JSON.parse(m[0]) as Partial<BookingExtraction>
    return {
      pax: typeof obj.pax === "number" ? obj.pax : null,
      preferred_date:
        typeof obj.preferred_date === "string" ? obj.preferred_date : null,
      date_range_start:
        typeof obj.date_range_start === "string" ? obj.date_range_start : null,
      date_range_end:
        typeof obj.date_range_end === "string" ? obj.date_range_end : null,
      weekends_only: obj.weekends_only === true,
      preferred_time:
        typeof obj.preferred_time === "string" ? obj.preferred_time : null,
      duration_hours:
        typeof obj.duration_hours === "number" ? obj.duration_hours : null,
      customer_name:
        typeof obj.customer_name === "string" ? obj.customer_name : null,
      notes: typeof obj.notes === "string" ? obj.notes : null,
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
    }
  } catch {
    return empty()
  }
}
