// Runs the fact-checker over every draft still waiting in hello@'s inbox
// (drafts written before the checker existed, 18 Nov 2026).
//   dry run (default): prints what it would change
//   --apply: replaces a wrong draft with the corrected text, in the same
//            thread, and labels drafts with open questions "Check before
//            sending". Drafts carrying attachments (invoices, the functions
//            pack) are never replaced, only labelled, so no PDF is lost.
// Never sends anything.
//   node dist/scripts/recheck-pending-drafts.js [--apply]

import { db } from "../db/pool.js"
import {
  applyLabel,
  createInThreadDraft,
  deleteThreadDrafts,
  getThread,
  getThreadDraftBody,
} from "../google/gmail.js"
import { upsertThread } from "../db/queries.js"
import { currentFactsBlock } from "../llm/drafter.js"
import { factCheck } from "../llm/factcheck.js"
import { recordKnowledgeGaps } from "../llm/knowledge.js"
import { dequote } from "../lib/dequote.js"
import { config } from "../config.js"
import { CHECK_LABEL } from "../pipeline.js"

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const hello = config().HELLO_MAILBOX.toLowerCase()
  const { rows } = await db().query<{ thread_id: string; category: string | null; meta: Record<string, unknown> }>(
    `SELECT thread_id, category, meta FROM inbox_threads
      WHERE state IN ('drafted','form_drafted') AND last_processed_at > now() - interval '45 days'
      ORDER BY last_processed_at DESC`
  )
  const facts = await currentFactsBlock()
  let fixed = 0, labelled = 0, ok = 0, skipped = 0
  // Gmail allows a fixed quota per minute shared with the live service: pace
  // the reads and wait out a quota error instead of skipping the thread.
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))
  const withQuota = async <T>(f: () => Promise<T>): Promise<T | null> => {
    for (let i = 0; i < 4; i++) {
      try { return await f() } catch (e) {
        if (!/quota|rate ?limit/i.test(e instanceof Error ? e.message : String(e))) return null
        await sleep(20_000)
      }
    }
    return null
  }
  for (const r of rows) {
    await sleep(1500)
    const thread = await withQuota(() => getThread(r.thread_id))
    if (!thread) { skipped++; continue }
    const inInbox = thread.messages.some((m) => m.labelIds.includes("INBOX"))
    const body = await getThreadDraftBody(r.thread_id)
    if (!inInbox || !body) { skipped++; continue }
    const threadText = thread.messages
      .map((m) => `[${m.date.toISOString().slice(0, 16)}] From: ${m.from}\n${dequote(m.bodyText).slice(0, 12000)}`)
      .join("\n\n---\n\n")
    const check = await factCheck({ factsBlock: facts, threadText, calendarBlock: "", draftBody: body })
    if (!check.ok) { console.log(`! ${r.thread_id} check failed`); skipped++; continue }
    if (!check.changed && !check.openQuestions.length) { ok++; continue }
    const subject = thread.messages[thread.messages.length - 1]!.subject
    console.log(`\n### ${r.thread_id} (${r.category}) "${subject}"`)
    for (const p of check.problems) console.log(`  * ${p}`)
    for (const q of check.openQuestions) console.log(`  ? ${q}`)
    const hasAttachments = Number(r.meta["attachmentCount"] ?? 0) > 0
    if (check.changed) console.log(`  --- corrected draft${hasAttachments ? " (NOT replaced: has attachments)" : ""} ---\n${check.body}`)
    if (!apply) continue
    if (check.changed && !hasAttachments) {
      const lastCustomer = [...thread.messages].reverse().find((m) => !m.from.toLowerCase().includes(hello))
      const tail = thread.messages[thread.messages.length - 1]!
      if (lastCustomer) {
        await deleteThreadDrafts(r.thread_id)
        const draftId = await createInThreadDraft(
          {
            threadId: r.thread_id,
            to: lastCustomer.from,
            subject: lastCustomer.subject,
            inReplyTo: tail.messageIdHeader ?? lastCustomer.messageIdHeader ?? "",
            references: tail.references ?? tail.messageIdHeader ?? lastCustomer.references ?? "",
          },
          check.body,
          config().HELLO_MAILBOX,
          "Tarte Team"
        )
        await upsertThread({
          thread_id: r.thread_id,
          last_message_id: tail.id,
          state: "drafted",
          last_action: "drafted",
          meta: { draftId, draftBody: check.body, draftedAt: new Date().toISOString(), factRecheckedAt: new Date().toISOString(), checkNotes: check.problems, openQuestions: check.openQuestions },
        })
        fixed++
      }
    }
    if (check.knowledgeGaps.length) await recordKnowledgeGaps(r.thread_id, r.category ?? "", check.knowledgeGaps)
    if (check.openQuestions.length || (check.changed && hasAttachments)) {
      await applyLabel(r.thread_id, CHECK_LABEL)
      labelled++
    }
  }
  console.log(`\n${rows.length} drafted threads: ${ok} fine, ${fixed} corrected, ${labelled} labelled to check, ${skipped} skipped (archived, sent or gone)${apply ? "" : " [DRY RUN]"}`)
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => db().end())
