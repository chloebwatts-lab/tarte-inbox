// Now Book It partner API (IPOS suite), READ ONLY.
// Docs: https://api-docs.nowbookit.com (authentication, ipos/bookings/*).
//
// Dormant until NBI_API_KEY is set (the key is issued by Now Book It per
// venue; the venue is resolved from the key, there is no venue header).
// Once set, the hello@ agent looks bookings up live instead of relying on the
// morning Daily Summary CSV, whose guest email column has always been blank.
//
// Deliberately no create / update / cancel here: every draft still waits for
// a teammate, who makes the change in Now Book It. Adding writes is a
// separate decision for Chloe.
//
// The CSV ingest (ingest.ts) stays the source for inbox_nbi_bookings. The API
// is NOT written into that table yet: the CSV keys rows by "Booking Reference"
// and the API by bookingId, and until we see live data we can't prove those
// are the same value. Mixing them could double every booking (calendar sync,
// high tea prep, guest confirmation emails).

import { config } from "../config.js"
import type { NbiBookingSummary } from "./ingest.js"

export interface NbiApiBooking {
  locationId?: string | null
  bookingId?: string | null
  method?: string | null
  bookedAt?: string | null // UTC
  bookingTime?: string | null // venue local, e.g. "2026-12-05T11:30:00"
  duration?: number
  people?: number
  customer?: {
    id?: string | null
    firstName?: string | null
    lastName?: string | null
    email?: string | null
    phone?: string | null
  } | null
  status?: { statusType?: string | null; code?: string | null; name?: string | null } | null
  notes?: string | null
  serviceId?: string | null
  serviceName?: string | null
  serviceType?: string | null
  lastModifiedDate?: string | null
}

export interface NbiScheduleService {
  id?: string | null
  name?: string | null
  online?: boolean
  duration?: number
  times?: Array<{
    name?: string | null // e.g. "6:00 PM"
    expired?: boolean
    bookingOptionsCount?: number
    time?: string | null // UTC
  }> | null
}

export interface NbiScheduleDay {
  isVenueOpen?: boolean
  blockoutMessage?: string | null
  services?: NbiScheduleService[] | null
}

export function nbiApiReady(): boolean {
  return !!config().NBI_API_KEY
}

class NbiApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function nbiGet<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const key = config().NBI_API_KEY
  if (!key) throw new NbiApiError(0, "NBI_API_KEY not set")
  const url = new URL(config().NBI_API_BASE_URL.replace(/\/+$/, "") + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  // 429 / 5xx: back off 500ms, 1s, 2s (as the docs recommend), then give up.
  let lastErr: NbiApiError | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(250 * 2 ** attempt)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { "X-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (e) {
      lastErr = new NbiApiError(0, e instanceof Error ? e.message : String(e))
      continue
    }
    if (res.ok) return (await res.json()) as T
    const text = (await res.text()).slice(0, 300)
    lastErr = new NbiApiError(res.status, `Now Book It ${res.status}: ${text}`)
    if (res.status !== 429 && res.status < 500) break
  }
  throw lastErr!
}

/** Bookings whose booking time falls in [start, end). */
export async function nbiListBookings(opts: {
  start: Date
  end: Date
  includeCancelled?: boolean
}): Promise<NbiApiBooking[]> {
  const r = await nbiGet<{ count?: number; bookings?: NbiApiBooking[] | null }>(
    "/Bookings",
    {
      StartDate: opts.start.toISOString(),
      EndDate: opts.end.toISOString(),
      IncludeCustomerDetails: true,
      IncludeCancelledBookings: opts.includeCancelled ?? false,
    }
  )
  return r.bookings ?? []
}

export async function nbiGetBooking(id: string): Promise<NbiApiBooking> {
  return nbiGet<NbiApiBooking>(`/Bookings/${encodeURIComponent(id)}`)
}

/** Bookable times for a party size on a day (whole day when no end given). */
export async function nbiSchedule(opts: {
  start: Date
  pax: number
  end?: Date
}): Promise<NbiScheduleDay[]> {
  return nbiGet<NbiScheduleDay[]>("/Bookings/schedule", {
    BookingDateTimeStart: opts.start.toISOString(),
    NumOfPeople: opts.pax,
    BookingDateTimeEnd: opts.end?.toISOString(),
  })
}

export async function nbiBookingStatuses(): Promise<
  Array<{ statusType?: string | null; code?: string | null; name?: string | null }>
> {
  return nbiGet("/Resources/booking-statuses")
}

// --- Upcoming bookings, cached -------------------------------------------

const UPCOMING_DAYS = 120
const WINDOW_DAYS = 30 // the list endpoint has no paging, so ask in slices
const CACHE_MS = 10 * 60 * 1000
let upcomingCache: { at: number; rows: NbiApiBooking[] } | undefined

/** Midnight today in Brisbane (UTC+10, no daylight saving). */
function brisbaneMidnight(): Date {
  const d = new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10)
  return new Date(`${d}T00:00:00+10:00`)
}

async function upcomingBookings(): Promise<NbiApiBooking[]> {
  if (upcomingCache && Date.now() - upcomingCache.at < CACHE_MS) {
    return upcomingCache.rows
  }
  const from = brisbaneMidnight()
  const seen = new Set<string>()
  const rows: NbiApiBooking[] = []
  for (let d = 0; d < UPCOMING_DAYS; d += WINDOW_DAYS) {
    const start = new Date(from.getTime() + d * 86400_000)
    const end = new Date(start.getTime() + WINDOW_DAYS * 86400_000)
    for (const b of await nbiListBookings({ start, end })) {
      const key = b.bookingId ?? `${b.bookingTime}|${b.customer?.email}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(b)
    }
  }
  upcomingCache = { at: Date.now(), rows }
  return rows
}

function toSummary(b: NbiApiBooking): NbiBookingSummary | null {
  const m = b.bookingTime?.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  if (!m) return null
  return {
    booking_ref: b.bookingId ?? "",
    booking_date: m[1]!,
    booking_time: m[2]!,
    service: b.serviceName ?? "",
    pax: b.people ?? 0,
    status: b.status?.name ?? "Unknown",
    notes: b.notes?.trim() || null,
  }
}

/**
 * Live version of nbiBookingsForEmail(): the customer's upcoming, not
 * cancelled bookings straight from Now Book It. Returns null (not []) when
 * the API is off or failing, so the caller falls back to the CSV table.
 */
export async function nbiApiBookingsForEmail(
  email: string
): Promise<NbiBookingSummary[] | null> {
  if (!nbiApiReady()) return null
  try {
    const want = email.trim().toLowerCase()
    return (await upcomingBookings())
      .filter((b) => b.customer?.email?.trim().toLowerCase() === want)
      .filter((b) => !/cancel/i.test(b.status?.name ?? ""))
      .map(toSummary)
      .filter((s): s is NbiBookingSummary => !!s)
      .sort((a, b) =>
        (a.booking_date + a.booking_time).localeCompare(b.booking_date + b.booking_time)
      )
      .slice(0, 5)
  } catch (e) {
    console.error("[nbi-api] lookup failed:", e instanceof Error ? e.message : e)
    return null
  }
}

/** Connection check for /nbi-api/status and the check script. No guest data. */
export async function nbiApiStatus(): Promise<{
  configured: boolean
  ok: boolean
  baseUrl: string
  error?: string
  statuses?: string[]
  next7Days?: number
  withGuestEmail?: number
  services?: Record<string, number>
}> {
  const baseUrl = config().NBI_API_BASE_URL
  if (!nbiApiReady()) return { configured: false, ok: false, baseUrl }
  try {
    const statuses = (await nbiBookingStatuses())
      .map((s) => s.name ?? "")
      .filter(Boolean)
    const start = brisbaneMidnight()
    const rows = await nbiListBookings({
      start,
      end: new Date(start.getTime() + 7 * 86400_000),
    })
    const services: Record<string, number> = {}
    for (const b of rows) {
      const k = b.serviceName ?? "(none)"
      services[k] = (services[k] ?? 0) + 1
    }
    return {
      configured: true,
      ok: true,
      baseUrl,
      statuses,
      next7Days: rows.length,
      withGuestEmail: rows.filter((b) => b.customer?.email).length,
      services,
    }
  } catch (e) {
    return {
      configured: true,
      ok: false,
      baseUrl,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
