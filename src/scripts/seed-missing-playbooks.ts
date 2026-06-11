// Seeds only playbook categories that don't exist in the DB yet. Unlike
// seed-playbooks.ts (which upserts everything and would clobber tuned
// voice_guidance / examples / faq), this is safe to run on prod any time.

import { migrate } from "../db/pool.js"
import { listPlaybooks, upsertPlaybook } from "../db/queries.js"
import { DEFAULTS } from "../playbooks/defaults.js"

async function main(): Promise<void> {
  await migrate()
  const existing = new Set((await listPlaybooks()).map((p) => p.category))
  for (const p of DEFAULTS) {
    if (existing.has(p.category)) {
      console.log(`exists, skipped: ${p.category}`)
      continue
    }
    await upsertPlaybook(p)
    console.log(`seeded: ${p.category}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
