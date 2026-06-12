// Mirrors ALL bookings into one dedicated Google calendar staff can see:
// every upcoming Now Book It booking (high teas + restaurant) and every
// function booking the agent is managing. Unconfirmed/deposit-pending
// entries are prefixed "TBC —" so anyone glancing at the calendar knows a
// window is held but not locked in.
//
// The combined calendar is display-only for humans; availability checks read
// the database + venue calendars as before, so mirroring here never double-
// counts. Requires the full calendar scope to CREATE the calendar on first
// run — until hello@ is re-authorised with it, sync logs a warning and skips.

import { google, type calendar_v3 } from "googleapis"
import { ensureGoogleAuthed } from "./oauth.js"
import { db } from "../db/pool.js"

const COMBINED_CALENDAR_NAME = "Tarte Bookings (auto)"
const SYNC_DAYS_AHEAD = 180
const SITTING_MINUTES: Record<string, number> = {} // per-service overrides
const DEFAULT_SITTING_MIN = 120
const HIGH_TEA_SITTING_MIN = 90

let cachedCalendarId: string | undefined

async function cal(): Promise<calendar_v3.Calendar> {
  const auth = await ensureGoogleAuthed()
  return google.calendar({ version: "v3", auth })
}

/** Finds (or creates) the combined calendar. Returns null when the token
 *  lacks the full calendar scope needed to create it. */
export async function ensureCombinedCalendar(): Promise<string | null> {
  if (cachedCalendarId) return cachedCalendarId
  const c = await cal()
  const list = await c.calendarList.list({ maxResults: 250 })
  const existing = (list.data.items ?? []).find(
    (x) => x.summary === COMBINED_CALENDAR_NAME
  )
  if (existing?.id) {
    cachedCalendarId = existing.id
    return existing.id
  }
  try {
    const created = await c.calendars.insert({
      requestBody: {
        summary: COMBINED_CALENDAR_NAME,
        timeZone: "Australia/Brisbane",
        description:
          "Auto-maintained by Tarte Inbox: all Now Book It bookings + function bookings. TBC = held, not locked in. Don't edit by hand — changes are overwritten hourly.",
      },
    })
    if (created.data.id) {
      cachedCalendarId = created.data.id
      console.log(`[calsync] created combined calendar ${created.data.id}`)
      return created.data.id
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/insufficient|forbidden|403/i.test(msg)) {
      console.warn(
        "[calsync] cannot create combined calendar — token lacks the full calendar scope. Re-authorise at /oauth/google/start to enable."
      )
      return null
    }
    throw e
  }
  return null
}

interface NbiCalRow {
  booking_ref: string
  booking_date: string
  booking_time: string
  service: string
  pax: number
  first_name: string | null
  last_name: string | null
  status: string
  notes: string | null
}

function sittingMinutes(service: string): number {
  if (/high tea/i.test(service)) return HIGH_TEA_SITTING_MIN
  return SITTING_MINUTES[service] ?? DEFAULT_SITTING_MIN
}

/** Gmail/Calendar event ids must match [a-v0-9]{5,}. NBI refs are numeric;
 *  function booking ids are small ints — both safe with a letter prefix. */
function nbiEventId(ref: string): string {
  return `nbi${ref.toLowerCase().replace(/[^a-v0-9]/g, "")}`
}

async function upsertEvent(
  c: calendar_v3.Calendar,
  calendarId: string,
  id: string,
  body: calendar_v3.Schema$Event
): Promise<void> {
  try {
    await c.events.insert({ calendarId, requestBody: { ...body, id } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/409|already exists/i.test(msg)) {
      await c.events.update({ calendarId, eventId: id, requestBody: body })
    } else if (/410/.test(msg)) {
      // id was used and deleted before — fall back to update (revives it)
      await c.events.update({ calendarId, eventId: id, requestBody: body })
    } else {
      throw e
    }
  }
}

async function deleteEvent(
  c: calendar_v3.Calendar,
  calendarId: string,
  id: string
): Promise<void> {
  try {
    await c.events.delete({ calendarId, eventId: id })
  } catch {
    // already gone — fine
  }
}

export async function syncCombinedCalendar(): Promise<{
  synced: number
  removed: number
} | null> {
  const calendarId = await ensureCombinedCalendar()
  if (!calendarId) return null
  const c = await cal()

  const { rows } = await db().query<NbiCalRow>(
    `SELECT booking_ref, booking_date::text, booking_time::text, service, pax,
            first_name, last_name, status, notes
       FROM inbox_nbi_bookings
      WHERE booking_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
        AND booking_date < (now() AT TIME ZONE 'Australia/Brisbane')::date + ${SYNC_DAYS_AHEAD}`
  )

  let synced = 0
  let removed = 0
  for (const b of rows) {
    const id = nbiEventId(b.booking_ref)
    if (b.status === "Cancelled") {
      await deleteEvent(c, calendarId, id)
      removed++
      continue
    }
    const tbc = b.status === "Unconfirmed"
    const who =
      [b.first_name, b.last_name].filter(Boolean).join(" ") || "unknown"
    const start = new Date(
      `${b.booking_date}T${b.booking_time.slice(0, 8)}+10:00`
    )
    const end = new Date(
      start.getTime() + sittingMinutes(b.service) * 60_000
    )
    await upsertEvent(c, calendarId, id, {
      summary: `${tbc ? "TBC — " : ""}${b.service}: ${who} (${b.pax} pax)`,
      description:
        `Now Book It ref ${b.booking_ref}\nStatus: ${b.status}` +
        (b.notes ? `\nNotes: ${b.notes}` : "") +
        `\n(Auto-synced — manage in Now Book It, not here.)`,
      start: { dateTime: start.toISOString(), timeZone: "Australia/Brisbane" },
      end: { dateTime: end.toISOString(), timeZone: "Australia/Brisbane" },
      transparency: tbc ? "transparent" : "opaque",
    })
    synced++
  }

  // Function bookings the agent manages (slot chosen or deposit invoiced).
  const fns = await db().query<{
    id: number
    venue: string
    state: string
    customer_name: string | null
    pax: number | null
    event_start: Date | null
    event_end: Date | null
  }>(
    `SELECT id, venue, state, customer_name, pax, event_start, event_end
       FROM inbox_bookings
      WHERE event_start IS NOT NULL AND event_start > now()
        AND state NOT IN ('cancelled')`
  )
  for (const f of fns.rows) {
    if (!f.event_start || !f.event_end) continue
    const tbc = f.state !== "deposit_paid" && f.state !== "paid"
    const venueName = f.venue === "tea_garden" ? "Tea Garden" : "Beach House"
    await upsertEvent(c, calendarId, `fnbooking${f.id}`, {
      summary: `${tbc ? "TBC — " : ""}Function ${venueName}: ${f.customer_name ?? "unknown"}${f.pax ? ` (${f.pax} pax)` : ""}`,
      description: `Inbox function booking ${f.id} — state: ${f.state}${tbc ? " (deposit not yet paid — held, not locked in)" : ""}`,
      start: {
        dateTime: new Date(f.event_start).toISOString(),
        timeZone: "Australia/Brisbane",
      },
      end: {
        dateTime: new Date(f.event_end).toISOString(),
        timeZone: "Australia/Brisbane",
      },
    })
    synced++
  }

  return { synced, removed }
}
