import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config.js"

let client: Anthropic | undefined

export function anthropic(): Anthropic {
  if (client) return client
  client = new Anthropic({ apiKey: config().ANTHROPIC_API_KEY })
  return client
}

// Classifier, extractors and other small calls. Their tight max_tokens limits
// assume a model that does not think first, so they stay here for now.
export const MODEL = "claude-sonnet-4-6"

// Customer reply drafts and the fact-checker (Chloe, 18 Nov 2026: replies
// must be right). Opus 5.5 always thinks, so callers give it room
// (max_tokens 16000) and read the text block, not content[0].
export const DRAFT_MODEL = "claude-opus-5-5"
