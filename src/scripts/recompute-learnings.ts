// One-off: recompute edit_distance for historical inbox_learnings rows.
// The original captureEdit compared the draft against the RAW sent body,
// which includes the quoted thread + signature — so every verbatim send
// looked like a huge rewrite and the auto-send trust data read 0% verbatim.
// This strips quotes/noise from the stored sent_reply and re-measures.
// Prints per-category before/after. Dry-run by default; --apply persists.

import { migrate, db } from "../db/pool.js"
import { dequote } from "../lib/dequote.js"
import { normalizeForDiff, levenshtein } from "../pipeline.js"

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  await migrate()
  const { rows } = await db().query<{
    id: number
    category: string | null
    our_draft: string
    sent_reply: string
    edit_distance: number
  }>(`SELECT id, category, our_draft, sent_reply, edit_distance FROM inbox_learnings`)

  const stats = new Map<string, { n: number; verbatim: number; sumOld: number; sumNew: number }>()
  for (const r of rows) {
    const a = normalizeForDiff(r.our_draft)
    const b = normalizeForDiff(dequote(r.sent_reply))
    const d = a === b ? 0 : levenshtein(a, b)
    const key = r.category ?? "(none)"
    const s = stats.get(key) ?? { n: 0, verbatim: 0, sumOld: 0, sumNew: 0 }
    s.n++
    if (d === 0) s.verbatim++
    s.sumOld += r.edit_distance
    s.sumNew += d
    stats.set(key, s)
    if (apply && d !== r.edit_distance) {
      await db().query(`UPDATE inbox_learnings SET edit_distance = $1 WHERE id = $2`, [d, r.id])
    }
  }

  console.log(`\n${apply ? "APPLIED" : "DRY RUN"} — ${rows.length} learnings recomputed\n`)
  console.log("category                       |   n | verbatim | avg old | avg new")
  for (const [k, s] of [...stats.entries()].sort((x, y) => y[1].n - x[1].n)) {
    console.log(
      `${k.padEnd(30)} | ${String(s.n).padStart(3)} | ${String(s.verbatim).padStart(8)} | ${String(Math.round(s.sumOld / s.n)).padStart(7)} | ${String(Math.round(s.sumNew / s.n)).padStart(7)}`
    )
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
