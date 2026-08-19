// Tolerant event-date parsing for staff-typed input. The invoice builder needs
// strict YYYY-MM-DD; the girls type "6/12/2026", "6th December", "Sat 6 Dec"
// or paste from an email. Before 2026-08-19 anything else crashed the
// /invoice/new form with a 500 (RangeError in dueLabelIfFuture). Now every
// staff-facing entry point normalises through here and rejects politely.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

function valid(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/** True when `s` is a real calendar date in strict YYYY-MM-DD form. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  return !!m && valid(Number(m[1]), Number(m[2]), Number(m[3]))
}

/**
 * Normalise a human-typed date to YYYY-MM-DD, or null if it can't be read.
 * Day-first (Australian) for numeric forms. A missing year resolves to the
 * next occurrence on/after `today` (YYYY-MM-DD) — event dates are always
 * in the future.
 */
export function normaliseEventDate(input: unknown, today?: string): string | null {
  if (typeof input !== "string") return null
  let s = input.trim().toLowerCase()
  if (!s) return null
  // Strip weekday names, ordinal suffixes, commas, "of", "the".
  s = s
    .replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday)?\b\.?,?/g, " ")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/\b(of|the)\b/g, " ")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  let m: RegExpExecArray | null

  // ISO / YYYY-MM-DD / YYYY/MM/DD (optionally with a time after it)
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\b|t|\s)/.exec(s + " "))) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
    return valid(y, mo, d) ? iso(y, mo, d) : null
  }
  // D/M/YYYY, D-M-YY, D.M.YYYY (day first)
  if ((m = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/.exec(s))) {
    const d = Number(m[1]), mo = Number(m[2])
    let y = m[3] ? Number(m[3]) : NaN
    if (m[3] && m[3].length === 2) y += 2000
    if (!m[3]) return nextOccurrence(mo, d, today)
    return valid(y, mo, d) ? iso(y, mo, d) : null
  }
  // "6 december 2026", "6 dec", "6 dec 26"
  if ((m = /^(\d{1,2}) ([a-z]+)(?: (\d{2,4}))?$/.exec(s))) {
    const d = Number(m[1]), mo = MONTHS[m[2]!]
    if (!mo) return null
    if (!m[3]) return nextOccurrence(mo, d, today)
    let y = Number(m[3])
    if (m[3].length === 2) y += 2000
    return valid(y, mo, d) ? iso(y, mo, d) : null
  }
  // "december 6 2026", "dec 6"
  if ((m = /^([a-z]+) (\d{1,2})(?: (\d{2,4}))?$/.exec(s))) {
    const mo = MONTHS[m[1]!], d = Number(m[2])
    if (!mo) return null
    if (!m[3]) return nextOccurrence(mo, d, today)
    let y = Number(m[3])
    if (m[3].length === 2) y += 2000
    return valid(y, mo, d) ? iso(y, mo, d) : null
  }
  return null
}

function nextOccurrence(mo: number, d: number, today?: string): string | null {
  const base = today && isIsoDate(today) ? today : new Date().toISOString().slice(0, 10)
  const y0 = Number(base.slice(0, 4))
  for (const y of [y0, y0 + 1]) {
    if (!valid(y, mo, d)) continue
    const cand = iso(y, mo, d)
    if (cand >= base) return cand
  }
  return null
}
