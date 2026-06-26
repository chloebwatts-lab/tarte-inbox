// Confirms whether a customer's message is genuinely saying they have PAID the
// deposit (as opposed to asking how to pay, promising to pay later, or talking
// about something else). Used to trigger a balance invoice — but the claim is
// never trusted as proof of payment; a human still verifies against the bank.

import { anthropic, MODEL } from "./client.js"

// Cheap pre-gate so we don't call the model on every message.
const PAID_HINT =
  /\b(paid|payment|transferr?ed|deposit|sent (?:the|you|over|through)|bank transfer|eft|just (?:paid|sent)|popped|put through)\b/i

export function looksLikeDepositPaidClaim(text: string): boolean {
  return PAID_HINT.test(text)
}

/** Returns true ONLY when the latest customer message clearly states the
 * deposit has already been paid/transferred. Asking how to pay, or saying they
 * will pay, is false. */
export async function confirmDepositPaid(latestMessage: string): Promise<boolean> {
  const r = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 10,
    system: [
      {
        type: "text",
        text:
          `You decide whether a customer's latest email says they have ALREADY PAID their booking deposit.\n` +
          `Answer ONLY "yes" or "no".\n` +
          `"yes" when they state the deposit/payment has been made or transferred (e.g. "just paid the deposit", "transfer's gone through", "I've sent the 50%").\n` +
          `"no" when they ask how/where to pay, say they WILL pay, query the amount, or it's unrelated.`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: latestMessage.slice(0, 4000) }],
  })
  const block = r.content[0]
  if (!block || block.type !== "text") return false
  return /\byes\b/i.test(block.text)
}
