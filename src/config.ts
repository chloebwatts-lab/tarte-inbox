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

  XERO_CLIENT_ID: z.string().min(1),
  XERO_CLIENT_SECRET: z.string().min(1),
  XERO_REDIRECT_URI: z.string().url(),

  TICK_INTERVAL_SECONDS: z.coerce.number().default(120),
  ENABLE_AUTO_SEND: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
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
