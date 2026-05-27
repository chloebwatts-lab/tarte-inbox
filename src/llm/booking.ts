import { anthropic, MODEL } from "./client.js"

export interface BookingExtraction {
  pax: number | null
  preferred_date: string | null // YYYY-MM-DD
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
  "preferred_time": "<HH:MM|null>",
  "duration_hours": <number|null>,
  "customer_name": "<string|null>",
  "notes": "<short summary string|null>",
  "confidence": <0..1>
}

Rules:
- Only fill fields you're reasonably sure about. Null is fine.
- Australian date format in source → convert to YYYY-MM-DD.
- Times in 24h. If only "lunch" / "dinner" mentioned, leave null.
- Customer name: their first name if extractable.`

export async function extractBooking(
  threadText: string
): Promise<BookingExtraction> {
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 400,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: threadText.slice(0, 8000) }],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") return empty()
  return parse(block.text)
}

function empty(): BookingExtraction {
  return {
    pax: null,
    preferred_date: null,
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
