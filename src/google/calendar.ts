import { google, type calendar_v3 } from "googleapis"
import { ensureGoogleAuthed } from "./oauth.js"
import { config } from "../config.js"

async function cal(): Promise<calendar_v3.Calendar> {
  const auth = await ensureGoogleAuthed()
  return google.calendar({ version: "v3", auth })
}

export type Venue = "tea_garden" | "beach_house"

export function calendarIdFor(venue: Venue): string {
  const c = config()
  return venue === "tea_garden"
    ? c.TEA_GARDEN_CALENDAR_ID
    : c.BEACH_HOUSE_CALENDAR_ID
}

export interface CalEvent {
  id: string
  start: Date
  end: Date
  summary: string
}

export async function listEvents(
  venue: Venue,
  rangeStart: Date,
  rangeEnd: Date
): Promise<CalEvent[]> {
  const c = await cal()
  const r = await c.events.list({
    calendarId: calendarIdFor(venue),
    timeMin: rangeStart.toISOString(),
    timeMax: rangeEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  })
  return (r.data.items ?? [])
    .filter((e) => e.start?.dateTime && e.end?.dateTime)
    .map((e) => ({
      id: e.id ?? "",
      start: new Date(e.start!.dateTime!),
      end: new Date(e.end!.dateTime!),
      summary: e.summary ?? "",
    }))
}

export interface Slot {
  start: Date
  end: Date
}

export function overlaps(a: Slot, b: Slot): boolean {
  return a.start < b.end && b.start < a.end
}

export async function isSlotFree(venue: Venue, slot: Slot): Promise<boolean> {
  // Pad ±30 mins for setup / pack-down clearance.
  const pad = 30 * 60 * 1000
  const range = await listEvents(
    venue,
    new Date(slot.start.getTime() - pad),
    new Date(slot.end.getTime() + pad)
  )
  return !range.some((e) => overlaps(slot, e))
}

export async function createEvent(
  venue: Venue,
  e: {
    summary: string
    description?: string
    start: Date
    end: Date
    attendees?: string[]
  }
): Promise<string> {
  const c = await cal()
  const r = await c.events.insert({
    calendarId: calendarIdFor(venue),
    requestBody: {
      summary: e.summary,
      description: e.description,
      start: { dateTime: e.start.toISOString(), timeZone: "Australia/Brisbane" },
      end: { dateTime: e.end.toISOString(), timeZone: "Australia/Brisbane" },
      attendees: e.attendees?.map((email) => ({ email })),
    },
  })
  if (!r.data.id) throw new Error("calendar event create returned no id")
  return r.data.id
}
