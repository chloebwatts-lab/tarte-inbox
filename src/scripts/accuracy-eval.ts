// How often are our drafts factually wrong? Read only: nothing is saved,
// drafted in Gmail or sent.
//
// Takes real past customer emails the team answered (inbox_learnings), cuts
// each thread back to the moment before the team's reply, and compares:
//   OLD  the draft the agent actually produced back then
//   NEW  a fresh draft from the current drafter + fact-checker
// A judge (separate call, same knowledge) reads the thread, the reply the team
// actually sent, and one candidate at a time, and lists factual errors:
// anything that contradicts our knowledge or the team's reply, or a claim
// about Tarte nothing supports.
//   node dist/scripts/accuracy-eval.js [count=30] [--ids 12,34]

import type Anthropic from "@anthropic-ai/sdk"
import { db } from "../db/pool.js"
import { getThread } from "../google/gmail.js"
import { getPlaybook } from "../db/queries.js"
import { currentFactsBlock, draft } from "../llm/drafter.js"
import { anthropic, DRAFT_MODEL } from "../llm/client.js"
import { dequote } from "../lib/dequote.js"
import { config } from "../config.js"
import type { Category } from "../llm/classifier.js"

const CUSTOMER_CATEGORIES = [
  "bookings_existing", "bookings_dine_in", "events_tea_garden_functions",
  "events_tea_garden_high_tea", "events_beach_house_functions", "orders_bespoke",
  "general_enquiries", "donations_fundraisers", "needs_human", "reviews",
]

const JUDGE = `You audit customer email drafts for Tarte for FACTUAL accuracy only (not tone or length).
You get: the email thread up to the point a reply was due, the reply the Tarte team actually sent, and one candidate draft.
Evidence, and which wins:
- Facts about THIS customer's booking (their date, numbers, what has been agreed, holds, what we already told them): the thread and the team's actual reply are the truth; the team knew the real situation.
- General facts about Tarte (what we offer, prices, policies, hours, spaces): the Business facts, PACKAGES BY SPACE and HOUSE KNOWLEDGE above are the truth. Use the team's reply for these only where our knowledge says nothing. The team sometimes sent an AI draft without checking it, so their reply can be wrong on general facts.
List every factual error in the candidate:
- contradicts our knowledge or the team's reply (wrong price, wrong policy, wrong space, wrong date or numbers, says we don't offer something we do, or the reverse)
- states something about Tarte that nothing in the evidence supports and that could mislead the customer
Do NOT count: missing details the team had from a phone call or elsewhere, tone, length, a different but true way of answering, an offer to check something.
send_ready = true only if the candidate could be sent with no factual fix.`

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["errors", "send_ready"],
  properties: {
    errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "why"],
        properties: { statement: { type: "string" }, why: { type: "string" } },
      },
    },
    send_ready: { type: "boolean" },
  },
} as const

interface Verdict { errors: Array<{ statement: string; why: string }>; send_ready: boolean }

async function judge(facts: string, threadText: string, sent: string, candidate: string, sentWasOldDraft: boolean): Promise<Verdict | null> {
  try {
    const r = await anthropic().messages.create({
      model: DRAFT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: [
        { type: "text", text: facts, cache_control: { type: "ephemeral" } },
        { type: "text", text: JUDGE, cache_control: { type: "ephemeral" } },
      ],
      messages: [{
        role: "user",
        content: `Thread (oldest first):\n\n${threadText}\n\n=== REPLY THE TEAM SENT${sentWasOldDraft ? " (this was the old AI draft sent with little or no change, so it is NOT independent evidence for general facts)" : ""} ===\n${sent}\n\n=== CANDIDATE DRAFT ===\n${candidate}`,
      }],
    })
    const t = r.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text
    return t ? (JSON.parse(t) as Verdict) : null
  } catch (e) {
    console.error("[judge]", e instanceof Error ? e.message : e)
    return null
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

async function evalOne(
  row: { id: number; thread_id: string; category: string; our_draft: string; sent_reply: string; noted_at: Date; edit_distance: number | null },
  facts: string
): Promise<string[] | null> {
  const hello = config().HELLO_MAILBOX.toLowerCase()
  const thread = await getThread(row.thread_id).catch(() => null)
  if (!thread) return null
  const needle = norm(row.sent_reply).slice(0, 60)
  let cut = thread.messages.findIndex(
    (m) => m.from.toLowerCase().includes(hello) && norm(dequote(m.bodyText)).includes(needle)
  )
  if (cut < 0) return null // can't find the team's reply: skip rather than guess
  const msgs = thread.messages.slice(0, cut)
  const last = [...msgs].reverse().find((m) => !m.from.toLowerCase().includes(hello))
  if (!last) return null
  const history = msgs.map((m) => ({ from: m.from, date: m.date, text: dequote(m.bodyText).slice(0, 16000) }))
  const threadText = history.map((m) => `[${m.date.toISOString().slice(0, 16)}] From: ${m.from}\n${m.text}`).join("\n\n---\n\n")
  const d = await draft({
    category: row.category as Category,
    playbook: await getPlaybook(row.category),
    threadHistory: history,
    customerName: last.from.match(/^"?([A-Za-z][A-Za-z'-]*)/)?.[1],
    dryRun: true,
    today: thread.messages[cut]!.date,
  })
  const sentWasOldDraft = (row.edit_distance ?? 999) < 60
  const [vo, vn] = await Promise.all([
    judge(facts, threadText, row.sent_reply, row.our_draft, sentWasOldDraft),
    judge(facts, threadText + (d.calendarBlock ? `\n\n${d.calendarBlock}` : ""), row.sent_reply, d.body || "(no draft)", sentWasOldDraft),
  ])
  if (!vo || !vn) return null
  const fmt = (v: Verdict) => (v.errors.length ? v.errors.map((e) => `      - ${e.statement} :: ${e.why}`).join("\n") : "      (none)")
  console.log(
    `\n#${row.id} ${row.category} ${row.noted_at.toISOString().slice(0, 10)}\n` +
      `  OLD errors ${vo.errors.length}${vo.send_ready ? " (send ready)" : ""}\n${fmt(vo)}\n` +
      `  NEW errors ${vn.errors.length}${vn.send_ready ? " (send ready)" : ""}  flags: ${d.flags.join(", ")}\n${fmt(vn)}` +
      (d.checkNotes?.length ? `\n  checker fixed:\n${d.checkNotes.map((n) => `      * ${n}`).join("\n")}` : "") +
      (d.openQuestions?.length ? `\n  must check: ${d.openQuestions.join(" | ")}` : "") +
      (d.bookingTasks?.length ? `\n  booking tasks: ${d.bookingTasks.join(" | ")}` : "")
  )
  return [
    String(row.id), row.category, String(vo.errors.length), String(vo.send_ready),
    String(vn.errors.length), String(vn.send_ready), String(!!d.openQuestions?.length),
  ]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const idsArg = args.indexOf("--ids")
  const ids = idsArg >= 0 ? args[idsArg + 1]!.split(",").map(Number) : null
  const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 30)
  const { rows } = ids
    ? await db().query(
        `SELECT id, thread_id, category, our_draft, sent_reply, noted_at, edit_distance FROM inbox_learnings WHERE id = ANY($1::int[])`,
        [ids]
      )
    : await db().query(
        `SELECT DISTINCT ON (thread_id) id, thread_id, category, our_draft, sent_reply, noted_at, edit_distance
           FROM inbox_learnings
          WHERE noted_at > now() - interval '75 days' AND category = ANY($1)
            AND length(sent_reply) > 80 AND length(our_draft) > 80
          ORDER BY thread_id, noted_at DESC`,
        [CUSTOMER_CATEGORIES]
      )
  const pool = ids ? rows : rows.sort((a, b) => +b.noted_at - +a.noted_at).slice(0, count)
  console.log(`evaluating ${pool.length} past emails`)
  const facts = await currentFactsBlock()
  const results: string[][] = []
  const queue = [...pool]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const r = await evalOne(row, facts).catch((e) => {
          console.error(`#${row!.id}`, e instanceof Error ? e.message : e)
          return null
        })
        if (r) results.push(r)
      }
    })
  )
  const n = results.length
  const pct = (k: number) => `${k}/${n} (${n ? Math.round((100 * k) / n) : 0}%)`
  const oldWrong = results.filter((r) => Number(r[2]) > 0).length
  const newWrong = results.filter((r) => Number(r[4]) > 0).length
  console.log(`\n========== SUMMARY (${n} emails) ==========`)
  console.log(`OLD drafts with a factual error: ${pct(oldWrong)}   send ready: ${pct(results.filter((r) => r[3] === "true").length)}`)
  console.log(`NEW drafts with a factual error: ${pct(newWrong)}   send ready: ${pct(results.filter((r) => r[5] === "true").length)}`)
  console.log(`NEW drafts labelled Check before sending: ${pct(results.filter((r) => r[6] === "true").length)}`)
  console.log(`errors total: old ${results.reduce((s, r) => s + Number(r[2]), 0)}, new ${results.reduce((s, r) => s + Number(r[4]), 0)}`)
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => db().end())
