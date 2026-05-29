// For each playbook example, keep the original incoming customer message
// but replace the human-written reply with what the agent WOULD draft today
// (given the current system prompt + voice guidance + templates + rules).
//
// Why: the human-written replies in the Sent folder carry old habits we no
// longer want — asking for dates already given, using "Hi" instead of "Hey",
// em-dashes, etc. The agent's drafts under current rules represent the
// IDEAL behaviour, so examples should demonstrate that.
//
// Skips categories that never draft a reply (forward_to set, voice_guidance
// explicitly says "Don't draft") because examples there are moot.
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/regenerate-examples.js

import { migrate } from "../db/pool.js"
import { listPlaybooks, upsertPlaybook, type Playbook } from "../db/queries.js"
import { draft } from "../llm/drafter.js"
import type { Category } from "../llm/classifier.js"

function shouldSkip(p: Playbook): boolean {
  if (p.forward_to) return true
  const guide = p.voice_guidance.toLowerCase()
  if (guide.includes("don't draft")) return true
  if (guide.includes("don't reply")) return true
  return false
}

async function regenerateForPlaybook(
  pb: Playbook
): Promise<{ before: number; after: number }> {
  const before = pb.examples.length
  // Temporarily empty examples so the drafter isn't influenced by old ones
  const cleanPlaybook: Playbook = { ...pb, examples: [] }
  const newExamples: Array<{ incoming: string; reply: string }> = []
  for (const ex of pb.examples) {
    if (!ex.incoming || ex.incoming.length < 30) continue
    try {
      // Treat the example's incoming as if it were a fresh customer email
      // arriving in a thread on its own. No customer name extraction — just
      // raw body. The drafter's "Hey there," fallback will kick in.
      const result = await draft({
        category: pb.category as Category,
        playbook: cleanPlaybook,
        threadHistory: [
          {
            from: "customer@example.com",
            date: new Date(),
            text: ex.incoming.slice(0, 4000),
          },
        ],
      })
      if (result.body && result.body.length > 30) {
        newExamples.push({
          incoming: ex.incoming,
          reply: result.body,
        })
      }
    } catch (e) {
      console.warn(
        `[regenerate] ${pb.category}: skipped one example —`,
        e instanceof Error ? e.message : e
      )
    }
  }
  if (newExamples.length === 0) return { before, after: 0 }
  await upsertPlaybook({ ...pb, examples: newExamples })
  return { before, after: newExamples.length }
}

async function main(): Promise<void> {
  await migrate()
  const playbooks = await listPlaybooks()
  console.log(`[regenerate] ${playbooks.length} playbooks total`)
  for (const pb of playbooks) {
    if (shouldSkip(pb)) {
      console.log(
        `[regenerate] ${pb.category}: SKIP (forward_to or no-reply rule)`
      )
      continue
    }
    if (!pb.examples.length) {
      console.log(`[regenerate] ${pb.category}: no examples to regenerate`)
      continue
    }
    process.stdout.write(`[regenerate] ${pb.category}: ${pb.examples.length} examples → drafting...`)
    const { before, after } = await regenerateForPlaybook(pb)
    console.log(` done (${after}/${before} kept)`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
