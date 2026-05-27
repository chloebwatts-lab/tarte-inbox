import Anthropic from "@anthropic-ai/sdk"
import { config } from "../config.js"

let client: Anthropic | undefined

export function anthropic(): Anthropic {
  if (client) return client
  client = new Anthropic({ apiKey: config().ANTHROPIC_API_KEY })
  return client
}

export const MODEL = "claude-sonnet-4-6"
