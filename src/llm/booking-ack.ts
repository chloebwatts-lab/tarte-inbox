// Parses a guest's reply to a booking-confirmation email. Cheap, single call,
// strict JSON out. Fail-safe: anything unparseable is treated as NOT
// acknowledged and needing a reply, so a human (or the normal pipeline)
// always picks it up rather than silently archiving a real question.

import { anthropic, MODEL } from "./client.js"

export interface BookingAck {
  acknowledged: boolean
  high_tea: "yes" | "no" | null
  needs_reply: boolean
  summary: string
}

const SYSTEM = `You read a restaurant guest's reply (possibly several messages) to a booking confirmation email from Tarte Beach House, Currumbin. The email confirmed their booking details and seating location and asked them to reply to confirm. Tea Garden guests were also asked whether they want high tea or the regular menu.

Output STRICT JSON only:
{
  "acknowledged": <true if the guest confirms the booking details are right>,
  "high_tea": "yes" | "no" | null,   // null when they didn't address it
  "needs_reply": <true if they asked a question, requested a change (time, pax, cancel), or anything else needs a human/agent response>,
  "summary": "<one short line, max 90 chars, plain text, no em dashes>"
}

Rules:
- "yes thanks" / "confirmed" / "see you then" => acknowledged true, needs_reply false.
- Any question, change request, dietary note, or cancellation => needs_reply true.
- A high tea request ("yes high tea please") is acknowledged true, high_tea "yes", needs_reply false (the venue handles it internally) UNLESS they also asked a question.
- When in doubt: acknowledged false, needs_reply true.`

export async function parseBookingAck(
  guestText: string,
  askedHighTea: boolean
): Promise<BookingAck> {
  const fallback: BookingAck = {
    acknowledged: false,
    high_tea: null,
    needs_reply: true,
    summary: "Reply could not be parsed, needs a look",
  }
  try {
    const r = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 200,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            (askedHighTea
              ? "This guest WAS asked the high tea question.\n\n"
              : "This guest was NOT asked about high tea (seated in the restaurant).\n\n") +
            `Guest reply:\n\n${guestText.slice(0, 4000)}`,
        },
      ],
    })
    const block = r.content[0]
    if (!block || block.type !== "text") return fallback
    const m = block.text.match(/\{[\s\S]*\}/)
    if (!m) return fallback
    const o = JSON.parse(m[0]) as Partial<BookingAck>
    return {
      acknowledged: o.acknowledged === true,
      high_tea: o.high_tea === "yes" ? "yes" : o.high_tea === "no" ? "no" : null,
      needs_reply: o.needs_reply !== false,
      summary:
        typeof o.summary === "string" && o.summary.trim()
          ? o.summary.trim().slice(0, 120)
          : "Guest replied",
    }
  } catch (e) {
    console.error("[confirm] ack parse failed:", e instanceof Error ? e.message : e)
    return fallback
  }
}
