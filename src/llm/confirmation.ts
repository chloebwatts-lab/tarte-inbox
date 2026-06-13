// Given a thread where we've already proposed function slots, decide what
// the customer's latest reply means.
//
// Returns one of:
//   confirmed       — customer accepted a specific slot
//   different_time  — customer wants a different time/date
//   declined        — customer no longer interested
//   question        — customer has more questions; no booking decision
//
// When confirmed, selected_slot_index points at which proposed slot they picked.

import { anthropic, MODEL } from "./client.js"

export type ConfirmationAction =
  | "confirmed"
  | "different_time"
  | "declined"
  | "question"

export interface ConfirmationResult {
  action: ConfirmationAction
  /** 0-based index into the proposed_slots array. Only set when action=confirmed. */
  selected_slot_index: number | null
  /** Free-text notes about what the customer wants (for different_time / question). */
  notes: string | null
  confidence: number
}

const SYSTEM = `You read a customer's reply to a function-booking proposal and decide what they meant. The previous email from us proposed a list of date/time slots. The customer is now replying.

Output STRICT JSON only:
{
  "action": "confirmed" | "different_time" | "declined" | "question",
  "selected_slot_index": <int|null>,
  "notes": "<short summary|null>",
  "confidence": <0..1>
}

Rules:
- "confirmed" only when the customer clearly picks a specific proposed slot ("Saturday at 12 works", "yes please, the 2pm one", "let's lock in the first option"). Set selected_slot_index to which one (0 = first proposed).
- "different_time" when they want a time NOT in the list ("could we do Sunday instead?", "is 6pm available?"). Capture what they want in notes.
- "declined" when they're cancelling / no longer interested.
- "question" when they're asking something but haven't picked yet ("do you have a vegan menu?", "what's the deposit?"). Default to this when unclear.
- If you're not at least 0.8 confident, prefer "question" over "confirmed".`

export async function classifyConfirmation(
  proposedSlotsHuman: string,
  customerReply: string
): Promise<ConfirmationResult> {
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 300,
    system: [
      { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content:
          `We previously proposed these slots:\n${proposedSlotsHuman}\n\n` +
          `Customer's reply:\n${customerReply.slice(0, 4000)}`,
      },
    ],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") return empty()
  return parse(block.text)
}

function empty(): ConfirmationResult {
  return {
    action: "question",
    selected_slot_index: null,
    notes: null,
    confidence: 0,
  }
}

function parse(text: string): ConfirmationResult {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return empty()
  try {
    const obj = JSON.parse(m[0]) as Partial<ConfirmationResult>
    const action: ConfirmationAction =
      obj.action === "confirmed" ||
      obj.action === "different_time" ||
      obj.action === "declined"
        ? obj.action
        : "question"
    const conf =
      typeof obj.confidence === "number" ? obj.confidence : 0
    // Force to "question" on a shaky signal: never create an invoice on a
    // low-confidence "confirmed", and don't re-roll dates on a low-confidence
    // "different_time" (an ambiguous "what about next month?" shouldn't
    // trigger unexpected new slot proposals).
    const safeAction: ConfirmationAction =
      (action === "confirmed" && conf < 0.8) ||
      (action === "different_time" && conf < 0.6)
        ? "question"
        : action
    return {
      action: safeAction,
      selected_slot_index:
        typeof obj.selected_slot_index === "number"
          ? obj.selected_slot_index
          : null,
      notes: typeof obj.notes === "string" ? obj.notes : null,
      confidence: conf,
    }
  } catch {
    return empty()
  }
}
