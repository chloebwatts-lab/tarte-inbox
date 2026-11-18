// ONE knowledge base for every draft (Chloe, 18 Nov 2026: "be better at your
// knowledge"). Before this, each email only saw the FAQ of the category the
// classifier picked, so a function enquiry or a donations request never saw
// the general_enquiries answer "SUP hire runs daily from the Beach House" and
// the drafter told two customers we don't do SUP. Now every draft, and the
// fact-checker, sees ALL of it:
//   - every live playbook FAQ answer (all categories)        -> CONFIRMED
//   - the staff handover sheets (inbox_knowledge)             -> DRAFT / CHECK
// The owner's rulings in BUSINESS_FACTS and PACKAGES BY SPACE sit above both.

import { db } from "../db/pool.js"

export interface KnowledgeRow {
  id: string
  topic: string
  question: string
  answer: string
  status: "confirmed" | "draft" | "check"
}

const CACHE_MS = 10 * 60_000
let cache: { at: number; rows: KnowledgeRow[] } | undefined

/** All knowledge rows, confirmed first. Never throws: a DB hiccup returns the
 * last good copy (or nothing) so drafting is never blocked. */
export async function loadKnowledge(): Promise<KnowledgeRow[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows
  try {
    const faq = await db().query<{ category: string; question: string; answer: string }>(
      `SELECT p.category, f->>'question' AS question, f->>'answer' AS answer
         FROM inbox_playbooks p, jsonb_array_elements(p.faq) f
        WHERE coalesce(trim(f->>'answer'), '') <> '' AND coalesce(trim(f->>'question'), '') <> ''
        ORDER BY p.category`
    )
    const seen = new Set<string>()
    const rows: KnowledgeRow[] = []
    faq.rows.forEach((r, i) => {
      const key = `${r.question.trim().toLowerCase()}|${r.answer.trim().toLowerCase()}`
      if (seen.has(key)) return
      seen.add(key)
      rows.push({
        id: `F${String(i + 1).padStart(3, "0")}`,
        topic: r.category.replace(/_/g, " "),
        question: r.question.trim(),
        answer: r.answer.trim(),
        status: "confirmed",
      })
    })
    const imported = await db()
      .query<{ id: string; category: string | null; venue: string | null; question: string; answer: string; status: string }>(
        `SELECT id, category, venue, question, answer, status FROM inbox_knowledge
          WHERE active ORDER BY source, id`
      )
      .catch(() => ({ rows: [] as never[] }))
    for (const r of imported.rows) {
      rows.push({
        id: r.id,
        topic: [r.category, r.venue && r.venue !== "Both" ? r.venue : ""].filter(Boolean).join(", "),
        question: r.question.trim(),
        answer: r.answer.trim(),
        status: r.status === "check" ? "check" : r.status === "confirmed" ? "confirmed" : "draft",
      })
    }
    cache = { at: Date.now(), rows }
    return rows
  } catch (e) {
    console.error("[knowledge] load failed:", e instanceof Error ? e.message : e)
    return cache?.rows ?? []
  }
}

/** The prompt block. Stable text (no dates), so it caches across drafts. */
export function renderKnowledge(rows: KnowledgeRow[]): string {
  if (!rows.length) return ""
  const tag = { confirmed: "CONFIRMED", draft: "DRAFT", check: "CHECK" } as const
  const lines = rows.map(
    (r) => `[${r.id} ${tag[r.status]}] (${r.topic}) Q: ${r.question}\nA: ${r.answer}`
  )
  return `HOUSE KNOWLEDGE: everything Tarte has written down. It applies to EVERY email, whatever the email is about.
How much to trust each row, highest first:
1. The Business facts and PACKAGES BY SPACE above. These are the owner's latest rulings and beat everything below.
2. CONFIRMED rows: answers the team wrote for customers. Quote them.
3. DRAFT rows: from staff handover sheets. Use them unless they clash with 1 or 2. Never quote a price that appears only in a DRAFT row: prices come from PACKAGES BY SPACE or a CONFIRMED row.
4. CHECK rows: the sources disagree or the owner has not confirmed. Use them only to avoid saying something wrong. Never state the disputed detail to a customer; leave it out and flag needs_human.
Some rows are written for staff (till buttons, who to ask, internal steps). Use them to understand the business, never pass internal process, systems or staff names to a customer.
If something is not covered here or above, you do not know it. Never claim Tarte does or does not offer something unless it is written here, above, or in the thread.

${lines.join("\n\n")}`
}

/** Knowledge text that counts as an authority for prices and amounts (the
 * unverified_price guard): confirmed rows only, never drafts or checks. */
export function confirmedKnowledgeText(rows: KnowledgeRow[]): string {
  return rows
    .filter((r) => r.status === "confirmed")
    .map((r) => `${r.question}\n${r.answer}`)
    .join("\n")
}

export async function recordKnowledgeGaps(
  threadId: string | undefined,
  category: string,
  questions: string[]
): Promise<void> {
  const qs = questions.map((q) => q.trim()).filter((q) => q.length > 3).slice(0, 5)
  if (!qs.length) return
  try {
    for (const q of qs) {
      await db().query(
        `INSERT INTO inbox_knowledge_gaps (thread_id, category, question) VALUES ($1, $2, $3)`,
        [threadId ?? null, category, q.slice(0, 500)]
      )
    }
  } catch (e) {
    console.error("[knowledge] gap record failed:", e instanceof Error ? e.message : e)
  }
}
