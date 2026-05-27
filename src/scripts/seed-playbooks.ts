import { migrate } from "../db/pool.js"
import { upsertPlaybook } from "../db/queries.js"
import { DEFAULTS } from "../playbooks/defaults.js"

async function main(): Promise<void> {
  await migrate()
  for (const p of DEFAULTS) {
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
