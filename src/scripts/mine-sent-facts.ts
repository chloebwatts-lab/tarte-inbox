// Staff handover: what does the team tell customers that is not written down
// anywhere, or that clashes with what is? Read only.
//
// Reads the replies the team actually sent from hello@ (inbox_learnings), in
// batches, against the full knowledge base, and returns every fact about
// Tarte that the knowledge base is missing or contradicts, with an example.
// Output: JSON lines on stdout prefixed "FACT " for the handover sheet.
//   node dist/scripts/mine-sent-facts.js [days=180]

import type Anthropic from "@anthropic-ai/sdk"
import { db } from "../db/pool.js"
import { currentFactsBlock } from "../llm/drafter.js"
import { anthropic, DRAFT_MODEL } from "../llm/client.js"

const MINER = `Below are replies the Tarte team actually sent to customers from hello@. Find every GENERAL fact about Tarte in them (what we offer, prices, what is included, policies, rules, hours, spaces, capacities, timings, how bookings, deposits, payments, cakes, dietaries, set-up, styling, drinks, kids, dogs, parking and access work) that is either:
- missing: nothing in the Business facts, PACKAGES BY SPACE or HOUSE KNOWLEDGE above covers it, or
- conflict: it disagrees with what is written above.
Ignore one-off details about a single customer's booking (their date, their numbers), pleasantries, and anything already covered and consistent.
Write each fact as a question a customer would ask plus the answer the team gave, in plain Australian English, no em dashes. Merge duplicates within this batch.`

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
        required: ["topic", "question", "team_answer", "kind", "written_says", "example_id"],
        properties: {
          topic: { type: "string" },
          question: { type: "string" },
          team_answer: { type: "string" },
          kind: { type: "string", enum: ["missing", "conflict"] },
          written_says: { type: "string" },
          example_id: { type: "integer" },
        },
      },
    },
  },
} as const

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 180)
  const { rows } = await db().query<{ id: number; category: string; sent_reply: string }>(
    `SELECT id, category, sent_reply FROM inbox_learnings
      WHERE noted_at > now() - ($1 || ' days')::interval
        AND category NOT IN ('job_applications','suppliers','marketing_cold_outreach','accounts_invoices')
        AND length(sent_reply) > 120 AND coalesce(edit_distance, 999) >= 40
      ORDER BY noted_at`,
    [String(days)]
  )
  console.error(`${rows.length} team-written replies (AI drafts sent unchanged are skipped)`)
  const facts = await currentFactsBlock()
  const batches: (typeof rows)[] = []
  for (let i = 0; i < rows.length; i += 35) batches.push(rows.slice(i, i + 35))
  const queue = batches.map((b, i) => ({ b, i }))
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const text = job.b
          .map((r) => `### reply ${r.id} (${r.category})\n${r.sent_reply.slice(0, 2500)}`)
          .join("\n\n")
        try {
          // Streamed: long answers trip the SDK's 10-minute guard otherwise.
          const r = await anthropic().messages.stream({
            model: DRAFT_MODEL,
            max_tokens: 32000,
            output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
            system: [
              { type: "text", text: facts, cache_control: { type: "ephemeral" } },
              { type: "text", text: MINER, cache_control: { type: "ephemeral" } },
            ],
            messages: [{ role: "user", content: text }],
          }).finalMessage()
          const t = r.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text
          const out = t ? (JSON.parse(t) as { facts: unknown[] }).facts : []
          for (const f of out) console.log("FACT " + JSON.stringify(f))
          console.error(`batch ${job.i + 1}/${batches.length}: ${out.length} facts`)
        } catch (e) {
          console.error(`batch ${job.i + 1} failed:`, e instanceof Error ? e.message : e)
        }
      }
    })
  )
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => db().end())
