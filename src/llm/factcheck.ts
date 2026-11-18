// The second agent (Chloe, 18 Nov 2026: "apply more / better agents ... we
// are worried you aren't correct"). Every customer draft is read by a separate
// checker before anyone sees it. It lists each claim the draft makes about
// Tarte, checks it against the same knowledge the drafter had plus the
// thread, and returns a corrected draft:
//   - a claim that contradicts our knowledge is corrected to the known fact
//   - a claim nothing supports is taken out (the SUP case: "that's not
//     something we run ourselves" was invented, and staff sent it as is)
//   - anything the customer asked that we cannot answer becomes an open
//     question for a teammate (and a knowledge gap, so it is answered once)
// It fails safe: if the check itself fails, the draft is kept and flagged.

import type Anthropic from "@anthropic-ai/sdk"
import { anthropic, DRAFT_MODEL } from "./client.js"

export interface FactCheckResult {
  ok: boolean // the check ran
  changed: boolean
  body: string
  problems: string[] // plain-English list of what was wrong and fixed
  openQuestions: string[] // must check before sending (drives the Gmail label)
  knowledgeGaps: string[] // general facts we lack: answer once, every email gains
  bookingTasks: string[] // routine booking-system jobs, shown in the digest/queue
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims", "revised_body", "knowledge_gaps", "must_check", "booking_tasks"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "verdict", "basis"],
        properties: {
          claim: { type: "string" },
          verdict: { type: "string", enum: ["supported", "contradicted", "unsupported"] },
          basis: { type: "string" },
        },
      },
    },
    revised_body: { type: "string" },
    knowledge_gaps: { type: "array", items: { type: "string" } },
    must_check: { type: "array", items: { type: "string" } },
    booking_tasks: { type: "array", items: { type: "string" } },
  },
} as const

const CHECKER = `You are the fact-checker for Tarte's customer emails. A drafting agent wrote the reply below. Staff are busy and often send drafts without changes, so anything wrong in it reaches the customer. Your job is to make sure every statement about Tarte is true.

Use ONLY: the Business facts, PACKAGES BY SPACE and HOUSE KNOWLEDGE above, the email thread, and any calendar check given. Nothing else counts as evidence, including your own general knowledge about cafes.

Step 1. List every claim the draft makes about Tarte or the customer's booking: what we do or do not offer, prices, what is included, hours, locations, spaces, policies (cakes, dogs, deposits, set menus, numbers), availability, dates, times, guest numbers, promises, links. Skip greetings and pleasantries.
Step 2. Give each claim a verdict:
- supported: our knowledge or the thread says so. In basis, name the row id (e.g. F012, Q031, M223) or "thread" or "business facts".
- contradicted: our knowledge says otherwise. In basis, quote the correct fact and its source.
- unsupported: nothing above says it either way. A claim that we DON'T offer something, or that something is not possible, is unsupported unless our knowledge says so plainly. Inventing a "no" has burned us (we were told we don't run SUP hire; we do).
Also check that each rule the draft applies fits THIS customer: the right space (Restaurant, Tea Garden, Hideout, Cafe, Burleigh) and the right kind of booking (table booking, high tea, private function). A rule applied to the wrong space or booking type is contradicted (e.g. the restaurant 12-16 set menu rule used on a Tea Garden high tea).
Calendar: a TAKEN or HELD entry is not proof another party has the space if the thread shows we placed a hold or booking for this same customer on that date. Then "the Hideout is booked" and any offer built on it (the Tea Garden section 4 prices) are contradicted: remove them, and ask staff to confirm the entry is the customer's own.
Booking steps (TABLE bookings and high teas the team enters in the booking system): "nothing else is needed", "no card needed" or "your booking is locked in" are contradicted when the thread shows the customer still has to complete the card pre-authorisation in their booking confirmation email, and unsupported when you cannot tell. Private functions secured by a deposit invoice do not use the pre-authorisation: a pre-auth reminder on those, or to a customer who has paid their invoice, is contradicted.
Promises: if the draft promises something that may not be possible (a pickup time, a visit, a table, extra time, a set-up) and our knowledge does not confirm it can be done, that promise is unsupported. Rewrite it so it does not commit ("we'll check the 7am pickup with the bakery and confirm"), and if a known fact limits it (opening hours, closing times, notice periods), apply that fact in the reply (e.g. "the Tea Garden closes at 2pm today, so before 2 is best").
Booking changes: the reply cannot change the booking system, so "we've cancelled / updated / moved your booking" is contradicted unless the thread shows it was done; change it to "we'll ..." (the team's wording).
Internal process: any line telling the customer a teammate will check or confirm "before this goes out", or mentioning drafts, flags, systems or labels, is contradicted (the customer only sees the sent email). Remove it.
Step 3. Write revised_body:
- If every claim is supported, return the draft exactly as given.
- Otherwise change as little as possible: correct each contradicted claim to the known fact; remove each unsupported claim, smoothing the sentence around it. Do not add new topics, prices or offers the customer did not ask about, except to replace a wrong statement with the right one.
- Never state a detail from a CHECK row or a price found only in a DRAFT row.
- Keep the greeting, voice, Australian spelling and the sign-off ("Kind Regards," then "Tarte Management"). No em dashes or en dashes.
Step 4. Three short lists for a teammate (each empty if none, keep them short):
- must_check: ONLY where the revised reply could still be wrong or leaves the customer's actual question unanswered unless a teammate checks something first (e.g. "Is the Hideout hold on 3 Jan this customer's own?", "The reply does not say whether we sell our cups; add the answer"). At most 2. Do not list routine booking-system work here, and do not list attachments: the functions pack is attached automatically to our first reply on a function enquiry.
- booking_tasks: routine jobs the teammate does in the booking system when they send this (e.g. "Change the 22 Nov booking from 16 to 15", "Note one vegetarian", "Cancel the 12 Dec booking"). At most 3.
- knowledge_gaps: GENERAL facts about Tarte the customer asked about, or you had to remove, that our knowledge does not cover, written so one answer serves every future email (e.g. "What does paddle board hire cost per hour?").`

/** Run the checker. Never throws. */
export async function factCheck(input: {
  factsBlock: string // the shared, cached knowledge system block
  threadText: string
  calendarBlock: string
  draftBody: string
}): Promise<FactCheckResult> {
  const fail = (why: string): FactCheckResult => {
    console.warn(`[factcheck] skipped: ${why}`)
    return { ok: false, changed: false, body: input.draftBody, problems: [], openQuestions: [], knowledgeGaps: [], bookingTasks: [] }
  }
  if (!input.draftBody.trim()) return fail("empty draft")
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: input.factsBlock, cache_control: { type: "ephemeral" } },
    { type: "text", text: CHECKER, cache_control: { type: "ephemeral" } },
  ]
  const user =
    `Email thread (oldest first):\n\n${input.threadText}` +
    (input.calendarBlock ? `\n\n${input.calendarBlock}` : "") +
    `\n\n=== DRAFT REPLY TO CHECK ===\n${input.draftBody}`
  let r: Anthropic.Message
  try {
    r = await anthropic().messages.create({
      model: DRAFT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system,
      messages: [{ role: "user", content: user }],
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  if (r.stop_reason === "refusal" || r.stop_reason === "max_tokens") return fail(r.stop_reason)
  const text = r.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text
  if (!text) return fail("no text")
  let parsed: {
    claims: Array<{ claim: string; verdict: string; basis: string }>
    revised_body: string
    knowledge_gaps: string[]
    must_check: string[]
    booking_tasks: string[]
  }
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail("bad json")
  }
  const bad = parsed.claims.filter((c) => c.verdict !== "supported")
  const revised = parsed.revised_body?.trim() ?? ""
  const changed = bad.length > 0 && revised.length > 0 && revised !== input.draftBody.trim()
  return {
    ok: true,
    changed,
    body: changed ? revised : input.draftBody,
    problems: bad.map((c) =>
      c.verdict === "contradicted"
        ? `Corrected: "${c.claim}" (${c.basis})`
        : `Removed, not in our knowledge: "${c.claim}"`
    ),
    openQuestions: (parsed.must_check ?? []).filter((q) => q.trim()),
    knowledgeGaps: (parsed.knowledge_gaps ?? []).filter((q) => q.trim()),
    bookingTasks: (parsed.booking_tasks ?? []).filter((q) => q.trim()),
  }
}
