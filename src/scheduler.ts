import { config } from "./config.js"
import {
  runTick,
  runInvoiceRequests,
  runInvoiceUpdates,
  sweepInvoiceDriveUploads,
  sweepSpam,
  reassertDraftUnread,
} from "./pipeline.js"
import { ingestNbi } from "./nbi/ingest.js"
import { digestDue, sendDailyDigest } from "./digest.js"
import { nudgeStaleBookings, followUpQuietInfoThreads } from "./followups.js"
import { runQuickChecks, recordTickResult } from "./health.js"

let running = false
let timer: NodeJS.Timeout | undefined
let nbiTimer: NodeJS.Timeout | undefined
let nbiRunning = false
let dailyTimer: NodeJS.Timeout | undefined
let dailyRunning = false
let healthTimer: NodeJS.Timeout | undefined
let healthRunning = false

const HEALTH_INTERVAL_MS = 15 * 60 * 1000 // watchdog quick checks

async function healthTick(): Promise<void> {
  if (healthRunning) return
  healthRunning = true
  try {
    await runQuickChecks()
  } catch (e) {
    console.error("[health] check run failed:", e instanceof Error ? e.message : e)
  } finally {
    healthRunning = false
  }
}

const NBI_INTERVAL_MS = 60 * 60 * 1000 // 1 hour — sweeps last 7 days; idempotent
const DAILY_CHECK_INTERVAL_MS = 10 * 60 * 1000 // digest + nudges checked every 10 min

async function dailyTick(): Promise<void> {
  if (dailyRunning) return
  dailyRunning = true
  try {
    // digestDue() gates on Brisbane 07:00 + once-per-day, so polling is cheap.
    if (await digestDue()) {
      const { xeroKeepalive } = await import("./xero/client.js")
      await xeroKeepalive()
      const { nudged } = await nudgeStaleBookings()
      if (nudged) console.log(`[followups] drafted ${nudged} nudge(s)`)
      const { nudged: infoNudged } = await followUpQuietInfoThreads()
      if (infoNudged) console.log(`[followups] drafted ${infoNudged} info follow-up(s)`)
      // Day-after-event close-out sweep (each booking flagged at most once).
      const { runPostEventSweep } = await import("./invoice/cancellation.js")
      const { flagged } = await runPostEventSweep()
      if (flagged) console.log(`[events] flagged ${flagged} finished-but-unsettled event(s)`)
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
  // Mirror everything into the combined staff calendar after each ingest.
  try {
    const { syncCombinedCalendar } = await import("./google/calendar-sync.js")
    const s = await syncCombinedCalendar()
    if (s) console.log(`[calsync] ${s.synced} synced, ${s.removed} removed`)
  } catch (e) {
    console.error("[calsync] error:", e instanceof Error ? e.message : e)
  }
  // Retry Drive archival for sent invoices missed at send time (e.g. pre-auth).
  try {
    const n = await sweepInvoiceDriveUploads()
    if (n) console.log(`[drive] swept ${n} sent-invoice thread(s) for archival`)
  } catch (e) {
    console.error("[drive] sweep error:", e instanceof Error ? e.message : e)
  }
  // Rescue genuine enquiries that landed in Spam (function requests etc.).
  try {
    await sweepSpam()
  } catch (e) {
    console.error("[spam] sweep error:", e instanceof Error ? e.message : e)
  }
  // Keep threads with pending drafts UNREAD so staff can't lose them.
  try {
    await reassertDraftUnread()
  } catch (e) {
    console.error("[unread] sweep error:", e instanceof Error ? e.message : e)
  }
  // Coverage sentinel: the end-to-end "no customer left unanswered" invariant.
  // Independent of the pipeline by design — alerts via the watchdog.
  try {
    const { runCoverageAudit } = await import("./coverage.js")
    await runCoverageAudit()
  } catch (e) {
    console.error("[coverage] audit error:", e instanceof Error ? e.message : e)
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
      await recordTickResult(true)
    } catch (e) {
      console.error("[scheduler] tick error:", e)
      await recordTickResult(false, e instanceof Error ? e.message : String(e))
    } finally {
      running = false
    }
    // On-demand invoices: staff apply the "Make Invoice" label to a thread.
    try {
      const { processed } = await runInvoiceRequests()
      if (processed) console.log(`[scheduler] make-invoice: processed ${processed}`)
    } catch (e) {
      console.error("[scheduler] make-invoice error:", e instanceof Error ? e.message : e)
    }
    // On-demand invoice amendments: staff apply the "Update Invoice" label.
    try {
      const { processed } = await runInvoiceUpdates()
      if (processed) console.log(`[scheduler] update-invoice: processed ${processed}`)
    } catch (e) {
      console.error("[scheduler] update-invoice error:", e instanceof Error ? e.message : e)
    }
    // Cancellations: staff apply the "Cancel Function" label. Marks the
    // booking cancelled, cleans up the Xero draft, briefs Louise + Chloe.
    try {
      const { runCancellations } = await import("./invoice/cancellation.js")
      const { processed } = await runCancellations()
      if (processed) console.log(`[scheduler] cancel-function: processed ${processed}`)
    } catch (e) {
      console.error("[scheduler] cancel-function error:", e instanceof Error ? e.message : e)
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

  // Watchdog: quick health checks every 15 min (alerts by email on failure).
  void healthTick()
  healthTimer = setInterval(() => void healthTick(), HEALTH_INTERVAL_MS)
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  if (nbiTimer) clearInterval(nbiTimer)
  if (dailyTimer) clearInterval(dailyTimer)
  if (healthTimer) clearInterval(healthTimer)
  timer = undefined
  nbiTimer = undefined
  dailyTimer = undefined
  healthTimer = undefined
}
