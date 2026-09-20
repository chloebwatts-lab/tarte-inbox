// Read-only audit of hello@: which customer emails have NO reply, NO pending
// draft and NO staff flag, and which drafts have sat unsent for 2+ days.
//
// Replaces the ad hoc audit-unread / why-skipped / tick-history scripts from
// the 2026-07-15 blind-inbox audit (they lived in a scratchpad and were never
// committed). Those checks became src/coverage.ts; this just runs that same
// sentinel in dry-run mode so it never touches labels, the watchdog or alert
// emails, and adds the pipeline's stored state for each thread it lists.
//
//   docker compose exec -T inbox node dist/scripts/coverage-audit.js

import { runCoverageAudit } from "../coverage.js"
import { db } from "../db/pool.js"

async function main(): Promise<void> {
  const r = await runCoverageAudit({ dryRun: true })
  console.log(`\nscanned ${r.scanned} inbox thread(s) from the last 30 days`)

  const show = async (
    title: string,
    rows: Array<{ id: string; from: string; subject: string; ageHours: number }>
  ): Promise<void> => {
    console.log(`\n########## ${title}: ${rows.length} ##########`)
    if (!rows.length) return
    const { rows: states } = await db().query<{
      thread_id: string
      category: string | null
      state: string | null
      last_action: string | null
    }>(
      `SELECT thread_id, category, state, last_action FROM inbox_threads WHERE thread_id = ANY($1::text[])`,
      [rows.map((x) => x.id)]
    )
    const byId = new Map(states.map((s) => [s.thread_id, s]))
    for (const v of [...rows].sort((a, b) => b.ageHours - a.ageHours)) {
      const s = byId.get(v.id)
      console.log(
        `  ${Math.round(v.ageHours)}h  ${v.from}  "${v.subject}"\n` +
          `       thread ${v.id}  pipeline: ${
            s ? `${s.category ?? "?"} / ${s.state ?? "?"} / ${s.last_action ?? "?"}` : "NEVER PROCESSED"
          }`
      )
    }
  }

  await show("UNANSWERED (no reply, no draft, no flag)", r.unanswered)
  await show("STALE DRAFTS (unsent 48h+)", r.staleDrafts)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
