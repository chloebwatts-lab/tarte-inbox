// Second step of the handover mining (mine-sent-facts.ts): merges the facts
// found batch by batch into one de-duplicated list, most useful first, so
// the team confirms each thing once. Reads "FACT {json}" lines on stdin.
//   node dist/scripts/merge-facts.js < mine.out > merged.json

import type Anthropic from "@anthropic-ai/sdk"
import { anthropic, DRAFT_MODEL } from "../llm/client.js"

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "question", "team_answer", "kind", "written_says", "example_ids", "times_seen"],
        properties: {
          topic: { type: "string" },
          question: { type: "string" },
          team_answer: { type: "string" },
          kind: { type: "string", enum: ["missing", "conflict"] },
          written_says: { type: "string" },
          example_ids: { type: "array", items: { type: "integer" } },
          times_seen: { type: "integer" },
        },
      },
    },
  },
} as const

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const facts = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.startsWith("FACT "))
    .map((l) => l.slice(5))
  console.error(`${facts.length} raw facts`)
  const r = await anthropic()
    .messages.stream({
      model: DRAFT_MODEL,
      max_tokens: 64000,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: `You merge a list of facts the Tarte team told customers (found reply by reply) into one clean handover list for the events team to confirm.
- Merge facts that say the same thing; times_seen = how many raw facts were merged; example_ids = their example_id values (max 5).
- If raw facts disagree with each other, keep ONE row whose team_answer states both versions plainly ("Sometimes X, sometimes Y") so she can pick.
- Keep only general facts about Tarte that future emails will need. Drop anything about one customer's booking.
- Order: conflicts first, then by times_seen, most first.
- Plain Australian English, no em dashes, short.`,
      messages: [{ role: "user", content: facts.join("\n") }],
    })
    .finalMessage()
  const t = r.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? '{"facts":[]}'
  const merged = JSON.parse(t) as { facts: unknown[] }
  console.error(`${merged.facts.length} merged facts`)
  console.log(JSON.stringify(merged.facts, null, 1))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
