// What the team's calendar can and cannot tell us about a date.
//
// Audit 12 Nov 2026: drafts kept telling customers a date "looks open". Three
// causes, all fixed here:
//  1. The calendar only holds PRIVATE FUNCTIONS (Hideout, private Tea Garden
//     hire). Restaurant and Tea Garden tables live in the booking system, which
//     we cannot see. An empty calendar day was being read as "free".
//  2. Only the first date the customer mentioned was checked, and only on a
//     brand new function enquiry. Follow-ups and table bookings got no check
//     at all and guessed.
//  3. A calendar that failed to load was skipped silently, which also read as
//     "nothing booked".
//
// So the calendar is used ONE WAY: it can prove a space is TAKEN. It can never
// prove anything is free. The drafter is told exactly that.

import { google } from "googleapis"
import { ensureGoogleAuthed } from "./google/oauth.js"
import { config } from "./config.js"

export type Space = "hideout" | "tea_garden" | "other"

export interface FunctionEntry {
  space: Space
  /** "all day" or "11:00am - 2:00pm" */
  timeLabel: string
  /** Enquiry / TBC hold rather than a confirmed function. */
  tentative: boolean
  summary: string
  /** The entry is (or may be) the booking of the customer we are replying to. */
  own?: "yes" | "maybe"
}

export interface DayPicture {
  date: string
  entries: FunctionEntry[]
  hideoutTaken: boolean
}

const HIDEOUT_RE = /hide\s?-?out/i
const TEA_GARDEN_RE = /tea\s?garden|\btg\b|whole venue|venue hire/i
const TENTATIVE_RE = /\btbc\b|enquir|tentative|\bhold\b|pencil/i
// Not functions: Gmail's auto "Reservation at ..." cards, cancelled entries,
// paddle board / kayak hire from the booking widget.
const IGNORE_RE = /^\s*(cancel+ed|reservation at\b)|paddle|kayak|\bsup hire\b/i

export function classifySpace(summary: string): Space {
  if (HIDEOUT_RE.test(summary)) return "hideout"
  if (TEA_GARDEN_RE.test(summary)) return "tea_garden"
  return "other"
}

export function isIgnorable(summary: string, eventType?: string | null): boolean {
  return eventType === "fromGmail" || IGNORE_RE.test(summary)
}

function fmtTime(d: Date): string {
  return d
    .toLocaleTimeString("en-AU", {
      timeZone: "Australia/Brisbane",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
    .replace(/\s/g, "")
    .toLowerCase()
}

function calendarIds(): string[] {
  return config()
    .BOOKING_CALENDAR_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Function entries on one Brisbane date across the team's calendars.
 * THROWS if any calendar cannot be read: a partial read must never be
 * mistaken for an empty day.
 */
/**
 * Is this calendar entry the booking of the customer we are writing to? The
 * team titles entries with the customer's name, so a customer who is mid
 * booking already has a hold on their own date. Telling them "the Hideout is
 * taken" because of their own hold would be exactly wrong.
 */
export function ownership(summary: string, customerNames: string[]): "yes" | "maybe" | undefined {
  const has = (w: string): boolean =>
    new RegExp(`\\b${w.replace(/[^a-z'-]/gi, "")}\\b`, "i").test(summary)
  let maybe = false
  for (const name of customerNames) {
    const words = name
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z'-]/g, ""))
      .filter((w) => w.length >= 3)
    if (!words.length) continue
    const first = words[0]!
    const last = words.length > 1 ? words[words.length - 1]! : null
    if (last && has(first) && has(last)) return "yes"
    if (has(first) || (last && last.length >= 5 && has(last))) maybe = true
  }
  return maybe ? "maybe" : undefined
}

export async function dayPicture(date: string, customerNames: string[] = []): Promise<DayPicture> {
  const auth = await ensureGoogleAuthed()
  const cal = google.calendar({ version: "v3", auth })
  const timeMin = new Date(`${date}T00:00:00+10:00`).toISOString()
  const timeMax = new Date(`${date}T23:59:59+10:00`).toISOString()
  const entries: FunctionEntry[] = []
  for (const calendarId of calendarIds()) {
    const r = await cal.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
    })
    for (const e of r.data.items ?? []) {
      const summary = (e.summary ?? "").trim()
      if (e.status === "cancelled" || isIgnorable(summary, e.eventType)) continue
      let timeLabel: string
      if (e.start?.dateTime && e.end?.dateTime) {
        timeLabel = `${fmtTime(new Date(e.start.dateTime))} - ${fmtTime(new Date(e.end.dateTime))}`
      } else if (e.start?.date) {
        timeLabel = "all day"
      } else continue
      entries.push({
        space: classifySpace(summary),
        timeLabel,
        tentative: TENTATIVE_RE.test(summary),
        summary: summary || "(untitled)",
        own: ownership(summary, customerNames),
      })
    }
  }
  return { date, entries, hideoutTaken: entries.some((e) => e.space === "hideout" && !e.own) }
}

function niceDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d)))
}

const SPACE_LABEL: Record<Space, string> = {
  hideout: "HIDEOUT",
  tea_garden: "TEA GARDEN private hire",
  other: "other entry (space not stated)",
}

export const AVAILABILITY_RULES = `How to use this (strict):
- Our calendar ONLY lists private functions. It does not show restaurant tables or Tea Garden tables, so it can prove a space is TAKEN but it can NEVER prove anything is free.
- NEVER tell the customer a date or time "is available", "looks open", "looks good", "works for us", "is free" or "is all yours", and never say a booking has been made. You cannot see that.
- If a space they want is listed as taken or held on their date, say so plainly (never name another customer), then offer what we CAN do: another date, or the Tea Garden options in section 4 of PACKAGES BY SPACE when it is the Hideout that is taken.
- Only mention that a space is taken if the customer asked for that space, asked for a private room, or it is clearly the right fit for what they want. Do not volunteer it otherwise.
- A "held" entry is another enquiry that has not confirmed. Treat the space as taken for now and add "needs_human" so a teammate can decide.
- If nothing clashes, do not comment on availability at all. Close with: "Let me know which option you are most interested in and I would be more than happy to check availability and get something booked in for you."
- Always add "needs_human" when the customer has named a date, so a teammate checks the calendar and the booking system before this is sent.`

/** Pure renderer, so it can be tested without Google. */
export function renderAvailability(days: DayPicture[], failed: string[] = []): string {
  if (!days.length && !failed.length) return ""
  const lines: string[] = [
    "Calendar check (internal, from the team's function calendar; never name another customer):",
  ]
  for (const day of days) {
    lines.push(`${niceDate(day.date)} (${day.date}):`)
    if (!day.entries.length) {
      lines.push(
        "  No private function is recorded. This does NOT mean the date is free: tables and unrecorded holds are not on this calendar."
      )
      continue
    }
    for (const e of day.entries) {
      if (e.own) {
        lines.push(
          e.own === "yes"
            ? `  - ${SPACE_LABEL[e.space]}: THIS CUSTOMER'S OWN ${e.tentative ? "hold" : "booking"} is already on our calendar, ${e.timeLabel}. It is theirs: do NOT tell them the space is taken.`
            : `  - ${SPACE_LABEL[e.space]}: an entry that looks like THIS CUSTOMER'S OWN ${e.tentative ? "hold" : "booking"} (same first name), ${e.timeLabel}. Do NOT tell them the space is taken; add "needs_human" so a teammate confirms it is theirs.`
        )
        continue
      }
      lines.push(
        `  - ${SPACE_LABEL[e.space]}: ${e.tentative ? "HELD (enquiry, not confirmed)" : "TAKEN"}, ${e.timeLabel}` +
          (e.timeLabel === "all day" ? " (no time recorded, treat the whole day as taken)" : "") +
          (e.space === "other" ? ` [calendar title: "${e.summary.slice(0, 80)}"]` : "")
      )
    }
    lines.push(
      day.hideoutTaken
        ? "  => The Hideout is NOT available this day. Section 4 Tea Garden prices apply for this date."
        : "  => No Hideout entry this day. Section 4 Tea Garden prices do NOT apply."
    )
  }
  for (const d of failed) {
    lines.push(
      `${niceDate(d)} (${d}): CALENDAR COULD NOT BE READ. Say nothing about availability for this date and add "needs_human".`
    )
  }
  lines.push("", AVAILABILITY_RULES)
  return lines.join("\n")
}

const MAX_DATES = 8

/** Dates worth checking from a booking extraction: every date the customer
 * named, plus each day of a range (weekends only when they said so). */
export function datesToCheck(x: {
  preferred_date: string | null
  date_range_start: string | null
  date_range_end: string | null
  weekends_only: boolean
  dates_mentioned?: string[]
}): string[] {
  const ok = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const out = new Set<string>()
  if (ok(x.preferred_date)) out.add(x.preferred_date)
  for (const d of x.dates_mentioned ?? []) if (ok(d)) out.add(d)
  if (ok(x.date_range_start) && ok(x.date_range_end) && x.date_range_start <= x.date_range_end) {
    let cur = x.date_range_start
    for (let i = 0; i < 45 && cur <= x.date_range_end; i++) {
      const [y, m, d] = cur.split("-").map(Number) as [number, number, number]
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
      if (!x.weekends_only || dow === 0 || dow === 6) out.add(cur)
      cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
    }
  }
  return [...out].sort().slice(0, MAX_DATES)
}

/** Calendar block for the drafter. Never throws: a date we could not read is
 * reported as unreadable rather than dropped. */
export async function availabilityBlock(dates: string[], customerNames: string[] = []): Promise<string> {
  const days: DayPicture[] = []
  const failed: string[] = []
  for (const d of dates.slice(0, MAX_DATES)) {
    try {
      days.push(await dayPicture(d, customerNames))
    } catch (e) {
      failed.push(d)
      console.error(`[availability] calendar read failed for ${d}:`, e instanceof Error ? e.message : e)
    }
  }
  return renderAvailability(days, failed)
}

// Phrases that assert availability or a made booking. The drafter is told not
// to write them; this catches the ones that slip through so staff see a flag.
const CLAIM_RE =
  /\b(looks?|looking|seems?)\s+(wide\s+)?(open|available|free|clear|good|great|workable)\b|\b(is|are)\s+(still\s+|currently\s+)?(available|free)\b|\bworks?\s+(well\s+for\s+us|for\s+us|well|perfectly)\b|\bwe\s+have\s+availability\b|\b(is|are)\s+all\s+yours\b|\b(have|has|'ve)\s+(gone\s+ahead\s+and\s+)?(booked|locked|reserved|pencilled)\b|\ball\s+booked\s+in\b/i

export function claimsAvailability(body: string): boolean {
  return CLAIM_RE.test(body)
}
