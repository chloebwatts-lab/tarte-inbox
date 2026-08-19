// One-off repair for the upsertThread state-reset bug (fixed 2026-08-19): every
// partial update (historyId-only refreshes when a thread was merely READ)
// clobbered `state` back to 'classified' while `last_action` kept the truth.
// Rebuild `state` from `last_action` (deterministic pairs in pipeline.ts) and,
// for drafted threads, from what Gmail actually shows now.
//
//   docker compose exec inbox node dist/scripts/repair-thread-states.js          (dry run)
//   docker compose exec inbox node dist/scripts/repair-thread-states.js --apply

import { db } from "../db/pool.js"
import { threadDraftReadState } from "../google/gmail.js"

const APPLY = process.argv.includes("--apply")

const BY_ACTION: Record<string, string> = {
  captured_edit: "sent_by_human",
  flagged_urgent: "urgent",
  flagged_bounce: "delivery_failure",
  skipped_handoff: "handed_off",
  draft_failed: "draft_failed",
  queue_done: "handled_manual",
  dismissed_trash: "dismissed_by_staff",
  dismissed_queue: "dismissed_by_staff",
  booking_ack: "ack_recorded",
  sent_forward: "forwarded",
  sent: "auto_sent",
  archived_noreply: "noreply_skipped",
}

async function main(): Promise<void> {
  const { rows } = await db().query<{
    thread_id: string
    last_action: string | null
    meta: Record<string, unknown>
  }>(
    `SELECT thread_id, last_action, meta FROM inbox_threads
      WHERE state = 'classified' AND last_action IS NOT NULL
        AND last_processed_at > now() - interval '120 days'
      ORDER BY last_processed_at DESC`
  )
  const counts: Record<string, number> = {}
  const bump = (k: string): void => {
    counts[k] = (counts[k] ?? 0) + 1
  }
  for (const r of rows) {
    const a = r.last_action!
    let target: string | null = null
    if (BY_ACTION[a]) target = BY_ACTION[a]!
    else if (a.startsWith("archived_")) target = "auto_archived"
    else if (a === "drafted") {
      // Ask Gmail what's true now.
      try {
        const s = await threadDraftReadState(r.thread_id)
        const draftedAt = r.meta["draftedAt"] ? new Date(String(r.meta["draftedAt"])).getTime() : 0
        if (s.trashed) target = "dismissed_by_staff"
        else if (s.repliedByUs && (!s.latestRealAt || !draftedAt || s.latestRealAt.getTime() > draftedAt))
          target = "sent_by_human"
        else if (s.hasDraft) target = r.meta["formSubmission"] === true ? "form_drafted" : "drafted"
        else target = "handled_manual" // draft gone, no reply from us: staff dealt with it some other way
      } catch (e) {
        console.log(`  ! ${r.thread_id}: gmail check failed (${e instanceof Error ? e.message : e})`)
        continue
      }
    }
    if (!target) {
      bump(`keep classified (${a})`)
      continue
    }
    bump(`${a} -> ${target}`)
    if (APPLY) {
      await db().query(`UPDATE inbox_threads SET state = $2 WHERE thread_id = $1 AND state = 'classified'`, [
        r.thread_id,
        target,
      ])
    }
  }
  console.log(APPLY ? "APPLIED:" : "DRY RUN (pass --apply to write):")
  for (const [k, v] of Object.entries(counts).sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
