import { migrate } from "../db/pool.js"
import { runTick } from "../pipeline.js"

async function main(): Promise<void> {
  await migrate()
  const r = await runTick()
  console.log(`tick complete: seen=${r.seen} acted=${r.acted}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
