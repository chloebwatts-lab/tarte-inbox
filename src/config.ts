import { z } from "zod"
import "dotenv/config"

const schema = z.object({
  PORT: z.coerce.number().default(8787),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  GMAIL_CLIENT_ID: z.string().min(1),
  GMAIL_CLIENT_SECRET: z.string().min(1),
  GMAIL_REDIRECT_URI: z.string().url(),
  HELLO_MAILBOX: z.string().email().default("hello@tarte.com.au"),

  TEA_GARDEN_CALENDAR_ID: z.string().min(1),
  BEACH_HOUSE_CALENDAR_ID: z.string().min(1),
  // The calendars the team actually keeps bookings/functions on — checked
  // (incl. all-day events) when judging availability. Comma-separated.
  BOOKING_CALENDAR_IDS: z
    .string()
    .default("primary,shawna@tarte.com.au"),

  XERO_CLIENT_ID: z.string().min(1),
  XERO_CLIENT_SECRET: z.string().min(1),
  XERO_REDIRECT_URI: z.string().url(),

  TICK_INTERVAL_SECONDS: z.coerce.number().default(120),
  // Auto-send a location-acknowledgement email to every NEW NBI dine-in
  // booking that has a guest email (see src/nbi/confirmations.ts). Safe to
  // leave on even while NBI's export carries no emails — those bookings are
  // just recorded as skipped.
  ENABLE_BOOKING_CONFIRMATIONS: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  ENABLE_AUTO_SEND: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  // When false (default), a customer confirming a slot NEVER auto-creates a
  // Xero invoice — the agent drafts the confirmation and flags a human to
  // raise the deposit invoice in Xero. Prevents auto-created invoices hitting
  // the accounts before anyone approves them.
  ENABLE_AUTO_INVOICE: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  // --- Own-invoice generator (Tarte-branded deposit invoices, no Xero) ---
  // All optional. The generator only activates once the essentials (business
  // name, ABN, bank name/BSB/account) are present — otherwise the booking
  // flow falls back to "deposit invoice will follow" + human flag.
  INVOICE_BUSINESS_NAME: z.string().optional(),
  INVOICE_ABN: z.string().optional(),
  INVOICE_ADDRESS: z.string().optional(), // commas or \n separated
  INVOICE_EMAIL: z.string().optional(),
  INVOICE_PHONE: z.string().optional(),
  INVOICE_BANK_ACCOUNT_NAME: z.string().optional(),
  INVOICE_BANK_NAME: z.string().optional(), // e.g. "Westpac"
  INVOICE_BANK_BSB: z.string().optional(),
  INVOICE_BANK_ACCOUNT_NUMBER: z.string().optional(),
  INVOICE_LOGO_PATH: z.string().optional(), // relative to /app/attachments
  INVOICE_GST_REGISTERED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() === "true"),
  INVOICE_NUMBER_PREFIX: z.string().default("TARTE"),
  INVOICE_DEPOSIT_DUE_DAYS: z.coerce.number().default(7),

  // --- Drive archive of sent invoices ---
  // When an invoice draft is sent by a human, a copy of the PDF is uploaded to
  // Google Drive. Optional: if a folder ID is given we upload into it; otherwise
  // the app creates/owns a "Tarte Invoices" folder under the drive.file scope.
  // Requires re-auth (drive.file scope) at /oauth/google/start.
  INVOICE_DRIVE_FOLDER_ID: z.string().optional(),
  INVOICE_DRIVE_FOLDER_NAME: z.string().default("Tarte Invoices"),

  // Secret token that unlocks the /invoices browse + edit pages without a
  // login prompt (capability URL). Visiting ?k=<token> once sets a cookie so
  // the rest just works. If unset, the pages are closed (403) — set it to
  // enable password-free access. Keep it long + random.
  INVOICE_PORTAL_TOKEN: z.string().optional(),

  // Where takeaway-high-tea pickup reminders are created. Defaults to the
  // staff shared calendar (hello@ has writer access to it).
  TAKEAWAY_REMINDER_CALENDAR_ID: z.string().default("shawna@tarte.com.au"),

  // Watchdog alert recipients (comma-separated). Alerts are written so the fix
  // is doable from a phone (re-auth links etc.). Chris = chloe@, plus Shawna
  // and the shared hello@ mailbox (per Chris 2026-07-12).
  ALERT_EMAILS: z.string().default("hello@tarte.com.au,chloe@tarte.com.au,shawna@tarte.com.au"),
})

export type Config = z.infer<typeof schema>

let cached: Config | undefined

export function config(): Config {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    console.error("invalid env:", parsed.error.flatten().fieldErrors)
    throw new Error("invalid env — see .env.example")
  }
  cached = parsed.data
  return cached
}
