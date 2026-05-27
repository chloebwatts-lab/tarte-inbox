// Surgically updates voice_guidance + reply_template + description for each
// playbook from defaults.ts, WITHOUT touching the examples array (so the
// ingested past-reply examples stay intact).
//
// Run on droplet:
//   docker compose exec inbox node dist/scripts/update-tone.js

import { db, migrate } from "../db/pool.js"
import { DEFAULTS } from "../playbooks/defaults.js"

async function main(): Promise<void> {
  await migrate()
  for (const p of DEFAULTS) {
    await db().query(
      `UPDATE inbox_playbooks
          SET description    = $2,
              voice_guidance = $3,
              reply_template = $4,
              updated_at     = now()
        WHERE category = $1`,
      [p.category, p.description, p.voice_guidance, p.reply_template]
    )
    console.log(`updated tone: ${p.category}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
