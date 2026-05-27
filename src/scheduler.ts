import { config } from "./config.js"
import { runTick } from "./pipeline.js"

let running = false
let timer: NodeJS.Timeout | undefined

export function startScheduler(): void {
  const intervalMs = config().TICK_INTERVAL_SECONDS * 1000
  const tick = async (): Promise<void> => {
    if (running) {
      console.log("[scheduler] previous tick still running — skipping")
      return
    }
    running = true
    const start = Date.now()
    try {
      const { seen, acted } = await runTick()
      const ms = Date.now() - start
      console.log(`[scheduler] tick: seen=${seen} acted=${acted} (${ms}ms)`)
    } catch (e) {
      console.error("[scheduler] tick error:", e)
    } finally {
      running = false
    }
  }
  // Kick once immediately, then on interval.
  void tick()
  timer = setInterval(() => void tick(), intervalMs)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
