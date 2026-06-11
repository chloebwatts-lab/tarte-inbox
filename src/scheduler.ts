import { config } from "./config.js"
import { runTick } from "./pipeline.js"
import { ingestNbi } from "./nbi/ingest.js"
import { digestDue, sendDailyDigest } from "./digest.js"
import { nudgeStaleBookings } from "./followups.js"

let running = false
let timer: NodeJS.Timeout | undefined
let nbiTimer: NodeJS.Timeout | undefined
let nbiRunning = false
let dailyTimer: NodeJS.Timeout | undefined
let dailyRunning = false

const NBI_INTERVAL_MS = 60 * 60 * 1000 // 1 hour — sweeps last 7 days; idempotent
const DAILY_CHECK_INTERVAL_MS = 10 * 60 * 1000 // digest + nudges checked every 10 min

async function dailyTick(): Promise<void> {
  if (dailyRunning) return
  dailyRunning = true
  try {
    // digestDue() gates on Brisbane 07:00 + once-per-day, so polling is cheap.
    if (await digestDue()) {
      const { nudged } = await nudgeStaleBookings()
      if (nudged) console.log(`[followups] drafted ${nudged} nudge(s)`)
      await sendDailyDigest()
    }
  } catch (e) {
    console.error("[daily] error:", e instanceof Error ? e.message : e)
  } finally {
    dailyRunning = false
  }
}

async function nbiTick(): Promise<void> {
  if (nbiRunning) return
  nbiRunning = true
  try {
    const r = await ingestNbi(7)
    if (r.rowsIngested > 0) {
      console.log(
        `[nbi] ${r.emailsScanned} email(s) -> ${r.rowsIngested} bookings`,
        r.byService
      )
    }
  } catch (e) {
    console.error(
      "[nbi] ingest error:",
      e instanceof Error ? e.message : e
    )
  } finally {
    nbiRunning = false
  }
}

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
  // Kick the email tick immediately + on interval.
  void tick()
  timer = setInterval(() => void tick(), intervalMs)

  // NBI ingest: once on startup (in case we missed any), then every hour.
  void nbiTick()
  nbiTimer = setInterval(() => void nbiTick(), NBI_INTERVAL_MS)

  // Daily digest + booking nudges: checked every 10 min, fires once per
  // Brisbane day after 07:00 (catches up on restart if the slot was missed).
  void dailyTick()
  dailyTimer = setInterval(() => void dailyTick(), DAILY_CHECK_INTERVAL_MS)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  if (nbiTimer) clearInterval(nbiTimer)
  if (dailyTimer) clearInterval(dailyTimer)
  timer = undefined
  nbiTimer = undefined
  dailyTimer = undefined
}
