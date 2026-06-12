// Ingests Now Book It bookings from the "Daily Summary" email that arrives
// at hello@ every morning around 06:00 AEST (20:00 UTC the day before). The
// email body is just "find attached" — the actual data is a CSV.
//
// Idempotent: each booking is keyed by NBI booking_ref. Re-ingesting an
// older email overwrites with the latest status (Confirmed / Cancelled etc).
// We sweep the last 7 days of summaries so a missed run doesn't lose data.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "../google/oauth.js"
import { db } from "../db/pool.js"

interface NbiRow {
  booking_ref: string
  booking_date: string // YYYY-MM-DD
  booking_time: string // HH:MM
  service: string
  pax: number
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  notes: string | null
  tags: string | null
  status: string
  seat_location: string | null
  booked_at: Date | null
  last_modified_at: Date | null
  payment_type: string | null
  total_amount: number | null
}

/** Minimal CSV parser that handles quoted fields with commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else {
      if (c === '"') inQuotes = true
      else if (c === ",") {
        row.push(field)
        field = ""
      } else if (c === "\n") {
        row.push(field)
        rows.push(row)
        field = ""
        row = []
      } else if (c === "\r") {
        // ignore
      } else {
        field += c
      }
    }
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function parseDateTime(s: string | undefined): Date | null {
  if (!s || !s.trim()) return null
  // NBI uses "YYYY-MM-DD HH:MM" in local time (AEST)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  if (!m) return null
  // Treat as Brisbane time (+10:00, no DST)
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+10:00`)
}

function parseRows(rows: string[][]): NbiRow[] {
  if (rows.length < 2) return []
  const headers = rows[0]!.map((h) => h.trim())
  const col = (name: string): number => headers.indexOf(name)
  const refCol = col("Booking Reference")
  const dateCol = col("Booking Date")
  const timeCol = col("Booking Time")
  const serviceCol = col("Service")
  const paxCol = col("Number of Guests")
  const fnCol = col("First Name")
  const lnCol = col("Last Name")
  const emailCol = col("Email")
  const phoneCol = col("Phone")
  const notesCol = col("Booking Notes")
  const tagsCol = col("Tags")
  const statusCol = col("Status")
  const seatCol = col("Wants to sit")
  const bookedAtCol = col("Booked At Date/Time")
  const modAtCol = col("Last Modified Date/Time")
  const paymentCol = col("Payment Type")
  const amountCol = col("Total Amount")

  const out: NbiRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!
    const rawRef = r[refCol] ?? ""
    // Some refs are wrapped like '="09730976"' (Excel sanitisation) — strip
    const ref = rawRef.replace(/^="?|"?$/g, "").replace(/^"|"$/g, "").trim()
    if (!ref) continue
    const dateStr = r[dateCol]?.trim() ?? ""
    const timeStr = r[timeCol]?.trim() ?? ""
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue
    const pax = Number(r[paxCol] ?? "0") || 0
    const amt = r[amountCol]?.trim()
    out.push({
      booking_ref: ref,
      booking_date: dateStr,
      booking_time: timeStr.match(/^\d{2}:\d{2}/)?.[0] ?? "00:00",
      service: r[serviceCol]?.trim() ?? "",
      pax,
      first_name: r[fnCol]?.trim() || null,
      last_name: r[lnCol]?.trim() || null,
      email: r[emailCol]?.trim() || null,
      phone: r[phoneCol]?.trim() || null,
      notes: r[notesCol]?.trim() || null,
      tags: r[tagsCol]?.trim() || null,
      status: r[statusCol]?.trim() || "Unconfirmed",
      seat_location: r[seatCol]?.trim() || null,
      booked_at: parseDateTime(r[bookedAtCol]),
      last_modified_at: parseDateTime(r[modAtCol]),
      payment_type: r[paymentCol]?.trim() || null,
      total_amount: amt ? Number(amt) : null,
    })
  }
  return out
}

export interface NbiIngestResult {
  emailsScanned: number
  rowsIngested: number
  byService: Record<string, number>
}

export async function ingestNbi(daysBack = 7): Promise<NbiIngestResult> {
  const auth = await ensureGoogleAuthed()
  const gmail = google.gmail({ version: "v1", auth })

  // Paginate: a long backfill (90d) spans more summary emails than one page.
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: `from:nowbookit.com has:attachment newer_than:${daysBack}d`,
      maxResults: 100,
      pageToken,
    })
    ids.push(...(list.data.messages ?? []).map((m) => m.id!).filter(Boolean))
    pageToken = list.data.nextPageToken ?? undefined
  } while (pageToken && ids.length < 400)

  let rowsIngested = 0
  const byService: Record<string, number> = {}

  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    })
    const atts: Array<{ filename: string; attachmentId: string }> = []
    const walk = (p: any): void => {
      if (p.filename?.toLowerCase().endsWith(".csv") && p.body?.attachmentId) {
        atts.push({ filename: p.filename, attachmentId: p.body.attachmentId })
      }
      for (const sub of p.parts ?? []) walk(sub)
    }
    walk(msg.data.payload)
    for (const a of atts) {
      const r = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: id,
        id: a.attachmentId,
      })
      if (!r.data.data) continue
      const csv = Buffer.from(r.data.data, "base64url").toString("utf8")
      const rows = parseRows(parseCsv(csv))
      for (const row of rows) {
        await db().query(
          `INSERT INTO inbox_nbi_bookings
             (booking_ref, booking_date, booking_time, service, pax,
              first_name, last_name, email, phone, notes, tags, status,
              seat_location, booked_at, last_modified_at, payment_type,
              total_amount, ingested_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
           ON CONFLICT (booking_ref) DO UPDATE SET
             booking_date = EXCLUDED.booking_date,
             booking_time = EXCLUDED.booking_time,
             service = EXCLUDED.service,
             pax = EXCLUDED.pax,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             email = EXCLUDED.email,
             phone = EXCLUDED.phone,
             notes = EXCLUDED.notes,
             tags = EXCLUDED.tags,
             status = EXCLUDED.status,
             seat_location = EXCLUDED.seat_location,
             booked_at = EXCLUDED.booked_at,
             last_modified_at = EXCLUDED.last_modified_at,
             payment_type = EXCLUDED.payment_type,
             total_amount = EXCLUDED.total_amount,
             ingested_at = now()`,
          [
            row.booking_ref,
            row.booking_date,
            row.booking_time,
            row.service,
            row.pax,
            row.first_name,
            row.last_name,
            row.email,
            row.phone,
            row.notes,
            row.tags,
            row.status,
            row.seat_location,
            row.booked_at,
            row.last_modified_at,
            row.payment_type,
            row.total_amount,
          ]
        )
        rowsIngested++
        byService[row.service] = (byService[row.service] ?? 0) + 1
      }
    }
  }
  return { emailsScanned: ids.length, rowsIngested, byService }
}

/**
 * Returns the count of CONFIRMED (or seated) NBI bookings for a given
 * service on a given date. Used by the Tea Garden function slot checker
 * to know if the venue is busy with high teas.
 */
export interface NbiBookingSummary {
  booking_ref: string
  booking_date: string
  booking_time: string
  service: string
  pax: number
  status: string
  notes: string | null
}

/**
 * Upcoming (today onward) non-cancelled NBI bookings for a customer email.
 * Used when someone emails about an existing booking, so the drafter can
 * speak to the actual reservation instead of asking them to repeat details.
 */
export async function nbiBookingsForEmail(
  email: string
): Promise<NbiBookingSummary[]> {
  const r = await db().query<NbiBookingSummary>(
    `SELECT booking_ref, booking_date::text, booking_time::text, service, pax, status, notes
       FROM inbox_nbi_bookings
      WHERE lower(email) = lower($1)
        AND booking_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
        AND status NOT IN ('Cancelled')
      ORDER BY booking_date, booking_time
      LIMIT 5`,
    [email]
  )
  return r.rows
}

/**
 * How many non-cancelled NBI bookings for a service overlap a time window.
 * booking_date/booking_time are Brisbane-local; sittingMinutes is how long a
 * booking occupies the space (high teas run 90-minute sittings).
 */
export async function nbiOverlapCount(
  service: string,
  slot: { start: Date; end: Date },
  sittingMinutes: number
): Promise<number> {
  const r = await db().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM inbox_nbi_bookings
      WHERE service = $1
        AND status NOT IN ('Cancelled')
        AND ((booking_date::text || ' ' || booking_time::text)::timestamp
               AT TIME ZONE 'Australia/Brisbane') < $3
        AND (((booking_date::text || ' ' || booking_time::text)::timestamp
               + make_interval(mins => $4)) AT TIME ZONE 'Australia/Brisbane') > $2`,
    [service, slot.start, slot.end, sittingMinutes]
  )
  return r.rows[0]?.n ?? 0
}

/** Ingest freshness + upcoming volume, for the daily digest. */
export async function nbiSyncStatus(): Promise<{
  lastIngest: Date | null
  upcoming7d: number
  byService7d: Record<string, number>
}> {
  const r = await db().query<{ last_ingest: Date | null }>(
    `SELECT max(ingested_at) AS last_ingest FROM inbox_nbi_bookings`
  )
  const u = await db().query<{ service: string; n: number }>(
    `SELECT service, count(*)::int AS n FROM inbox_nbi_bookings
      WHERE status NOT IN ('Cancelled')
        AND booking_date >= (now() AT TIME ZONE 'Australia/Brisbane')::date
        AND booking_date < (now() AT TIME ZONE 'Australia/Brisbane')::date + 7
      GROUP BY service`
  )
  const byService7d: Record<string, number> = {}
  let upcoming7d = 0
  for (const row of u.rows) {
    byService7d[row.service] = row.n
    upcoming7d += row.n
  }
  return { lastIngest: r.rows[0]?.last_ingest ?? null, upcoming7d, byService7d }
}

export async function nbiBookingsForDate(
  service: string,
  date: string // YYYY-MM-DD
): Promise<Array<{ pax: number; booking_time: string }>> {
  const r = await db().query<{ pax: number; booking_time: string }>(
    `SELECT pax, booking_time::text
       FROM inbox_nbi_bookings
      WHERE service = $1 AND booking_date = $2
        AND status NOT IN ('Cancelled')
      ORDER BY booking_time`,
    [service, date]
  )
  return r.rows
}
