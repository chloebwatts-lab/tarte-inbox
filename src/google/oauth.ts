// Shared OAuth client for Gmail + Calendar. Single Google OAuth client,
// multiple scopes, single set of tokens stored in DB.
import { google } from "googleapis"
import { OAuth2Client } from "google-auth-library"
import { config } from "../config.js"
import { getTokens, saveTokens } from "../db/queries.js"

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
]

let cachedClient: OAuth2Client | undefined

export function oauthClient(): OAuth2Client {
  if (cachedClient) return cachedClient
  const c = config()
  cachedClient = new google.auth.OAuth2(
    c.GMAIL_CLIENT_ID,
    c.GMAIL_CLIENT_SECRET,
    c.GMAIL_REDIRECT_URI
  )
  // Persist refreshed tokens back to DB automatically.
  cachedClient.on("tokens", (t) => {
    void saveTokens({
      provider: "google",
      access_token: t.access_token ?? "",
      refresh_token: t.refresh_token ?? null,
      scope: t.scope ?? null,
      token_type: t.token_type ?? null,
      expiry: t.expiry_date ? new Date(t.expiry_date) : null,
    }).catch((e) => console.error("[google] failed to persist refreshed token:", e))
  })
  return cachedClient
}

export function googleAuthUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token issuance on first link
    scope: GOOGLE_SCOPES,
    state,
  })
}

export async function exchangeGoogleCode(code: string): Promise<void> {
  const { tokens } = await oauthClient().getToken(code)
  await saveTokens({
    provider: "google",
    access_token: tokens.access_token ?? "",
    refresh_token: tokens.refresh_token ?? null,
    scope: tokens.scope ?? null,
    token_type: tokens.token_type ?? null,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
  })
}

/** Load tokens from DB and apply to the shared client. Throws if not linked. */
export async function ensureGoogleAuthed(): Promise<OAuth2Client> {
  const client = oauthClient()
  const stored = await getTokens("google")
  if (!stored) {
    throw new Error(
      "google not linked — visit /oauth/google/start once to authorise hello@tarte.com.au"
    )
  }
  client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    scope: stored.scope ?? undefined,
    token_type: stored.token_type ?? undefined,
    expiry_date: stored.expiry ? stored.expiry.getTime() : undefined,
  })
  return client
}
