// Weekly: distil what staff ACTUALLY changed in our drafts into short,
// factual proposals for the playbooks. Proposals are stored + surfaced in the
// Monday digest — never auto-applied (Chris decides what sticks). This is the
// "it actually learns" loop Fyxer never had.

import { anthropic, MODEL } from "./client.js"
import { db } from "../db/pool.js"

interface LearningRow {
  category: string
  our_draft: string
  sent_reply: string
  edit_distance: number
}

function mondayOfThisWeekBrisbane(): string {
  const now = new Date()
  const brisbane = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Brisbane" }))
  const day = brisbane.getDay() // 0 Sun .. 6 Sat
  const diff = day === 0 ? 6 : day - 1
  brisbane.setDate(brisbane.getDate() - diff)
  return brisbane.toISOString().slice(0, 10)
}

/** Generate this week's synthesis if it doesn't exist yet (idempotent).
 * Only meaningful edits count (distance > 40 chars after normalization). */
export async function maybeSynthesizeLearnings(): Promise<number> {
  const week = mondayOfThisWeekBrisbane()
  const { rows: existing } = await db().query(
    `SELECT 1 FROM inbox_learning_notes WHERE week_start = $1 LIMIT 1`,
    [week]
  )
  if (existing.length) return 0

  const { rows } = await db().query<LearningRow>(
    `SELECT category, our_draft, sent_reply, edit_distance
       FROM inbox_learnings
      WHERE created_at > now() - interval '7 days'
        AND edit_distance > 40
        AND category IS NOT NULL
      ORDER BY category, edit_distance DESC`
  )
  if (!rows.length) return 0

  const byCategory = new Map<string, LearningRow[]>()
  for (const r of rows) {
    const list = byCategory.get(r.category) ?? []
    if (list.length < 6) list.push(r) // cap prompt size per category
    byCategory.set(r.category, list)
  }

  let created = 0
  for (const [category, samples] of byCategory) {
    if (samples.length < 2) continue // one edit is noise, not a pattern
    const pairs = samples
      .map(
        (s, i) =>
          `--- Example ${i + 1} ---\nAGENT DRAFT:\n${s.our_draft.slice(0, 1200)}\n\nSTAFF ACTUALLY SENT:\n${s.sent_reply.slice(0, 1200)}`
      )
      .join("\n\n")
    try {
      const r = await anthropic().messages.create({
        model: MODEL,
        max_tokens: 400,
        system: [
          {
            type: "text",
            text:
              `You compare an email agent's drafts with what hospitality staff actually sent, for ONE category of email. ` +
              `Identify only PATTERNS that repeat across examples (tone shifts, things staff always add/remove, structural changes). ` +
              `Output 1-4 short bullet points of proposed guidance for the agent, each starting "- ". ` +
              `Be concrete and factual — only describe differences actually visible in the examples. ` +
              `If the differences look random or one-off, output exactly: NO PATTERN`,
          },
        ],
        messages: [{ role: "user", content: `Category: ${category}\n\n${pairs}` }],
      })
      const block = r.content[0]
      if (!block || block.type !== "text") continue
      const text = block.text.trim()
      if (!text || /^NO PATTERN/i.test(text)) continue
      await db().query(
        `INSERT INTO inbox_learning_notes (week_start, category, proposal, sample_size)
         VALUES ($1, $2, $3, $4) ON CONFLICT (week_start, category) DO NOTHING`,
        [week, category, text, samples.length]
      )
      created++
    } catch (e) {
      console.error(`[learn] synthesis for ${category} failed:`, e instanceof Error ? e.message : e)
    }
  }
  if (created) console.log(`[learn] synthesized ${created} categorie(s) of staff-edit patterns`)
  return created
}

/** This week's proposals for the digest (empty string if none). */
export async function learningDigestSection(): Promise<string> {
  const week = mondayOfThisWeekBrisbane()
  // Only show proposals the day they were generated — repeating them in every
  // digest all week would train staff to skim past the section.
  const { rows } = await db().query<{ category: string; proposal: string; sample_size: number }>(
    `SELECT category, proposal, sample_size FROM inbox_learning_notes
      WHERE week_start = $1 AND created_at > now() - interval '26 hours'
      ORDER BY category`,
    [week]
  )
  if (!rows.length) return ""
  return (
    `🧠 What I noticed from your edits this week (proposals only — tell Chris which to apply):\n` +
    rows
      .map((r) => `  ${r.category.replace(/_/g, " ")} (${r.sample_size} edits):\n${r.proposal.replace(/^/gm, "    ")}`)
      .join("\n")
  )
}
