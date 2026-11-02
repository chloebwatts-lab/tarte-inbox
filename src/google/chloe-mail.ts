// Read-only Gmail access to chloe@tarte.com.au for Claude bookkeeper (CBK)
// sessions. Chloe approved this on 2 Nov 2026.
//
// Isolation rules (enforced by scripts/test-chloe-guard.ts):
// - Its own OAuth2 client instance and its own token row (provider
//   "gmail_chloe"). It never touches the hello@ client in google/oauth.ts.
// - One scope only: gmail.readonly. The callback refuses a grant that carries
//   any other scope, and ensureChloeAuthed re-checks the stored scope on every
//   use, so a wider grant can never be used even if one were stored by hand.
// - The callback refuses any account other than chloe@tarte.com.au and revokes
//   the token it was handed.
// - Nothing in the hello@ pipeline, scheduler, digest, health or invoice code
//   imports this file. Only server.ts (consent routes + /status line) and
//   scripts/chloe-mail.ts (the CLI) do.
import { google, type gmail_v1 } from "googleapis"
import { OAuth2Client } from "google-auth-library"
import { config } from "../config.js"
import { getTokens, saveTokens } from "../db/queries.js"

export const CHLOE_PROVIDER = "gmail_chloe" as const
export const CHLOE_MAILBOX = "chloe@tarte.com.au"
export const CHLOE_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const
// Carried through Google's redirect so the shared /oauth/google/callback can
// tell this flow from the hello@ one. No Google Cloud console change needed.
export const CHLOE_OAUTH_STATE = "chloe-readonly"
export const CHLOE_START_PATH = "/oauth/chloe/start"

const ALLOWED_SCOPES = new Set<string>([
  ...CHLOE_SCOPES,
  // Google sometimes echoes identity scopes back; harmless, read-only.
  "openid",
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
])
const WRITE_SCOPE = /gmail\.(modify|send|compose|labels|insert|settings|metadata)|mail\.google\.com/i

/** Throws unless every granted scope is in the read-only allow list. */
export function assertReadOnlyScope(scope: string | null | undefined): void {
  const granted = (scope ?? "").split(/\s+/).filter(Boolean)
  if (!granted.includes(CHLOE_SCOPES[0])) {
    throw new Error(`chloe@ grant is missing ${CHLOE_SCOPES[0]}`)
  }
  for (const s of granted) {
    if (WRITE_SCOPE.test(s) || !ALLOWED_SCOPES.has(s)) {
      throw new Error(`chloe@ grant carries a scope that is not read-only: ${s}`)
    }
  }
}

function newClient(): OAuth2Client {
  const c = config()
  return new google.auth.OAuth2(c.GMAIL_CLIENT_ID, c.GMAIL_CLIENT_SECRET, c.GMAIL_REDIRECT_URI)
}

let cached: OAuth2Client | undefined

function client(): OAuth2Client {
  if (cached) return cached
  cached = newClient()
  cached.on("tokens", (t) => {
    void saveTokens({
      provider: CHLOE_PROVIDER,
      access_token: t.access_token ?? "",
      refresh_token: t.refresh_token ?? null,
      scope: t.scope ?? null,
      token_type: t.token_type ?? null,
      expiry: t.expiry_date ? new Date(t.expiry_date) : null,
    }).catch((e) => console.error("[chloe-mail] failed to persist refreshed token:", e))
  })
  return cached
}

export function chloeAuthUrl(): string {
  return newClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...CHLOE_SCOPES],
    state: CHLOE_OAUTH_STATE,
    login_hint: CHLOE_MAILBOX,
    include_granted_scopes: false,
  })
}

/**
 * Finish the consent flow. Uses a throwaway client so a refused account never
 * lands on the cached one. Stores the token only when the scope is exactly
 * read-only and the signed-in account is chloe@.
 */
export async function exchangeChloeCode(code: string): Promise<{ email: string }> {
  const temp = newClient()
  const { tokens } = await temp.getToken(code)
  const revoke = async (): Promise<void> => {
    if (tokens.access_token) await temp.revokeToken(tokens.access_token).catch(() => undefined)
  }
  try {
    assertReadOnlyScope(tokens.scope)
  } catch (e) {
    await revoke()
    throw e
  }
  temp.setCredentials(tokens)
  const profile = await google.gmail({ version: "v1", auth: temp }).users.getProfile({ userId: "me" })
  const email = (profile.data.emailAddress ?? "").trim().toLowerCase()
  if (email !== CHLOE_MAILBOX) {
    await revoke()
    throw new Error(`refused: signed in as ${email || "an unknown account"}, this link is for ${CHLOE_MAILBOX} only`)
  }
  if (!tokens.refresh_token) {
    console.warn("[chloe-mail] no refresh token in grant; access will lapse within the hour")
  }
  await saveTokens({
    provider: CHLOE_PROVIDER,
    access_token: tokens.access_token ?? "",
    refresh_token: tokens.refresh_token ?? null,
    scope: tokens.scope ?? null,
    token_type: tokens.token_type ?? null,
    expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    extra: { email, readonly: true, linked_at: new Date().toISOString() },
  })
  cached = undefined
  return { email }
}

export async function chloeStatus(): Promise<{
  linked: boolean
  email: string | null
  scope: string | null
  expiry: Date | null
  readonly: boolean
}> {
  const stored = await getTokens(CHLOE_PROVIDER)
  if (!stored) return { linked: false, email: null, scope: null, expiry: null, readonly: true }
  let readonly = true
  try {
    assertReadOnlyScope(stored.scope)
  } catch {
    readonly = false
  }
  return {
    linked: true,
    email: typeof stored.extra?.["email"] === "string" ? (stored.extra["email"] as string) : null,
    scope: stored.scope,
    expiry: stored.expiry,
    readonly,
  }
}

async function ensureChloeAuthed(): Promise<OAuth2Client> {
  const stored = await getTokens(CHLOE_PROVIDER)
  if (!stored) {
    throw new Error(`chloe@ not linked: Chloe opens ${config().PUBLIC_BASE_URL}${CHLOE_START_PATH} once, signed in as ${CHLOE_MAILBOX}`)
  }
  assertReadOnlyScope(stored.scope)
  const c = client()
  c.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    scope: stored.scope ?? undefined,
    token_type: stored.token_type ?? undefined,
    expiry_date: stored.expiry ? stored.expiry.getTime() : undefined,
  })
  return c
}

async function gmail(): Promise<gmail_v1.Gmail> {
  return google.gmail({ version: "v1", auth: await ensureChloeAuthed() })
}

// --- Parsing (own copy, so this file stays independent of google/gmail.ts) ---

export interface ChloeAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface ChloeMessage {
  id: string
  threadId: string
  date: string
  from: string
  to: string[]
  cc: string[]
  subject: string
  labelIds: string[]
  snippet: string
  bodyText: string
  attachments: ChloeAttachment[]
}

export interface ChloeThreadSummary {
  id: string
  date: string
  from: string
  to: string[]
  subject: string
  snippet: string
  messages: number
  attachments: string[]
}

function header(msg: gmail_v1.Schema$Message, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
}

function decode(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : ""
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
}

function walk(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string
  html: string
  attachments: ChloeAttachment[]
} {
  const out = { text: "", html: "", attachments: [] as ChloeAttachment[] }
  if (!payload) return out
  const visit = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.filename && p.body?.attachmentId) {
      out.attachments.push({
        id: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body.size ?? 0,
      })
    } else if (p.mimeType === "text/plain" && p.body?.data) {
      out.text += decode(p.body.data)
    } else if (p.mimeType === "text/html" && p.body?.data) {
      out.html += decode(p.body.data)
    }
    for (const sub of p.parts ?? []) visit(sub)
  }
  visit(payload)
  return out
}

function addresses(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)
}

function parseMessage(msg: gmail_v1.Schema$Message): ChloeMessage {
  const { text, html, attachments } = walk(msg.payload ?? undefined)
  const ms = msg.internalDate ? Number(msg.internalDate) : 0
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    date: ms ? new Date(ms).toISOString() : "",
    from: header(msg, "from") ?? "",
    to: addresses(header(msg, "to")),
    cc: addresses(header(msg, "cc")),
    subject: header(msg, "subject") ?? "",
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet ?? "",
    bodyText: (text || stripHtml(html)).trim(),
    attachments,
  }
}

// --- Read operations (the only operations this module has) ---

export const SEARCH_MAX_LIMIT = 50

export async function searchThreads(query: string, max = 10): Promise<ChloeThreadSummary[]> {
  const g = await gmail()
  const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(max)))
  const list = await g.users.threads.list({ userId: "me", q: query, maxResults: limit })
  const ids = (list.data.threads ?? []).map((t) => t.id).filter((id): id is string => Boolean(id))
  const out: ChloeThreadSummary[] = []
  for (const id of ids) {
    const r = await g.users.threads.get({ userId: "me", id, format: "full" })
    const msgs = (r.data.messages ?? []).map(parseMessage)
    const first = msgs[0]
    const last = msgs[msgs.length - 1]
    if (!first || !last) continue
    out.push({
      id,
      date: last.date,
      from: last.from,
      to: last.to,
      subject: first.subject || last.subject,
      snippet: last.snippet,
      messages: msgs.length,
      attachments: [...new Set(msgs.flatMap((m) => m.attachments.map((a) => a.filename)))],
    })
  }
  return out
}

export async function getThread(threadId: string): Promise<{ id: string; messages: ChloeMessage[] }> {
  const g = await gmail()
  const r = await g.users.threads.get({ userId: "me", id: threadId, format: "full" })
  return { id: threadId, messages: (r.data.messages ?? []).map(parseMessage) }
}

export async function getMessage(messageId: string): Promise<ChloeMessage> {
  const g = await gmail()
  const r = await g.users.messages.get({ userId: "me", id: messageId, format: "full" })
  return parseMessage(r.data)
}

export async function getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
  const g = await gmail()
  const r = await g.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId })
  if (!r.data.data) throw new Error("attachment has no data")
  return Buffer.from(r.data.data, "base64url")
}
