import { serve } from "@hono/node-server"
import { app } from "./server.js"
import { config } from "./config.js"
import { migrate } from "./db/pool.js"
import { startScheduler } from "./scheduler.js"

async function main(): Promise<void> {
  const c = config()
  await migrate()
  serve({ fetch: app.fetch, port: c.PORT }, ({ port }) => {
    console.log(`[tarte-inbox] http listening on :${port}`)
    console.log(
      `[tarte-inbox] auto_send=${c.ENABLE_AUTO_SEND} tick=${c.TICK_INTERVAL_SECONDS}s`
    )
  })
  startScheduler()
}

main().catch((e) => {
  console.error("[tarte-inbox] fatal:", e)
  process.exit(1)
})
