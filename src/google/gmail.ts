import { google, type gmail_v1 } from "googleapis"
import { ensureGoogleAuthed } from "./oauth.js"

async function gmail(): Promise<gmail_v1.Gmail> {
  const auth = await ensureGoogleAuthed()
  return google.gmail({ version: "v1", auth })
}

export interface ParsedMessage {
  id: string
  threadId: string
  from: string
  to: string[]
  cc: string[]
  subject: string
  messageIdHeader: string | undefined
  references: string | undefined
  inReplyTo: string | undefined
  date: Date
  bodyText: string
  bodyHtml: string
  labelIds: string[]
  snippet: string
}

export interface ParsedThread {
  threadId: string
  historyId: string | undefined
  messages: ParsedMessage[]
}

function header(
  msg: gmail_v1.Schema$Message,
  name: string
): string | undefined {
  return msg.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  )?.value ?? undefined
}

function decodeBody(data: string | undefined | null): string {
  if (!data) return ""
  return Buffer.from(data, "base64url").toString("utf8")
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): {
  text: string
  html: string
} {
  if (!payload) return { text: "", html: "" }
  let text = ""
  let html = ""
  const walk = (p: gmail_v1.Schema$MessagePart): void => {
    if (p.mimeType === "text/plain" && p.body?.data) {
      text += decodeBody(p.body.data)
    } else if (p.mimeType === "text/html" && p.body?.data) {
      html += decodeBody(p.body.data)
    }
    for (const sub of p.parts ?? []) walk(sub)
  }
  walk(payload)
  return { text, html }
}

function parseAddresses(value: string | undefined): string[] {
  if (!value) return []
  return value.split(",").map((s) => s.trim()).filter(Boolean)
}

function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const { text, html } = extractBody(msg.payload ?? undefined)
  const dateMs = msg.internalDate ? Number(msg.internalDate) : Date.now()
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: header(msg, "from") ?? "",
    to: parseAddresses(header(msg, "to")),
    cc: parseAddresses(header(msg, "cc")),
    subject: header(msg, "subject") ?? "",
    messageIdHeader: header(msg, "message-id"),
    references: header(msg, "references"),
    inReplyTo: header(msg, "in-reply-to"),
    date: new Date(dateMs),
    bodyText: text || stripHtml(html),
    bodyHtml: html,
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet ?? "",
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Search recent inbox threads — including ones that have been READ but not
 * replied to. Previously this was `is:unread` only, which meant any thread
 * Shawna or Georgia clicked open (accidentally or otherwise) got skipped
 * forever. The pipeline's per-thread dedupe (last_message_id, last_action)
 * prevents re-processing already-handled threads.
 *
 * Capped to the last 30 days + maxResults 50 to keep API + prompt cost sane.
 */
export async function listInboxThreads(
  query = "in:inbox newer_than:30d -category:promotions"
): Promise<string[]> {
  const g = await gmail()
  const r = await g.users.threads.list({
    userId: "me",
    q: query,
    maxResults: 50,
  })
  return (r.data.threads ?? []).map((t) => t.id!).filter(Boolean)
}

export async function getThread(threadId: string): Promise<ParsedThread> {
  const g = await gmail()
  const r = await g.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  })
  return {
    threadId,
    historyId: r.data.historyId ?? undefined,
    messages: (r.data.messages ?? []).map(parseMessage),
  }
}

// --- Labels ---

let labelCache: Map<string, string> | undefined

async function loadLabels(): Promise<Map<string, string>> {
  if (labelCache) return labelCache
  const g = await gmail()
  const r = await g.users.labels.list({ userId: "me" })
  labelCache = new Map(
    (r.data.labels ?? [])
      .filter((l) => l.name && l.id)
      .map((l) => [l.name!.toLowerCase(), l.id!])
  )
  return labelCache
}

export async function ensureLabel(name: string): Promise<string> {
  const labels = await loadLabels()
  const existing = labels.get(name.toLowerCase())
  if (existing) return existing
  const g = await gmail()
  const r = await g.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  })
  if (!r.data.id) throw new Error(`failed to create label ${name}`)
  labels.set(name.toLowerCase(), r.data.id)
  return r.data.id
}

export async function applyLabel(
  threadId: string,
  labelName: string
): Promise<void> {
  const id = await ensureLabel(labelName)
  const g = await gmail()
  await g.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: [id] },
  })
}

// --- Drafts + sends, both in-thread ---

interface ReplyContext {
  threadId: string
  to: string
  cc?: string[]
  subject: string
  inReplyTo: string // Message-ID header of the message being replied to
  references: string // existing References header (we append inReplyTo)
}

export interface Attachment {
  filename: string
  contentType: string
  data: Buffer
}

function mimeTypeFor(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? ""
  return (
    {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
    }[ext] ?? "application/octet-stream"
  )
}

function buildRfc822(
  ctx: ReplyContext,
  fromEmail: string,
  fromName: string | undefined,
  bodyText: string,
  attachments: Attachment[] = []
): string {
  const subj = ctx.subject.toLowerCase().startsWith("re:")
    ? ctx.subject
    : `Re: ${ctx.subject}`
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  const refs = [ctx.references, ctx.inReplyTo].filter(Boolean).join(" ")

  const baseHeaders = [
    `From: ${fromHeader}`,
    `To: ${ctx.to}`,
    ctx.cc?.length ? `Cc: ${ctx.cc.join(", ")}` : null,
    `Subject: ${subj}`,
    `In-Reply-To: ${ctx.inReplyTo}`,
    `References: ${refs}`,
    `MIME-Version: 1.0`,
  ].filter(Boolean) as string[]

  if (!attachments.length) {
    return [
      ...baseHeaders,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      bodyText,
    ].join("\r\n")
  }

  // Multipart with attachments
  const boundary = `boundary_${Math.random().toString(36).slice(2)}${Date.now()}`
  const parts: string[] = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    bodyText,
  ]
  for (const a of attachments) {
    const b64 = a.data.toString("base64")
    // Wrap base64 at 76 chars per line per RFC
    const wrapped = b64.match(/.{1,76}/g)?.join("\r\n") ?? b64
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrapped
    )
  }
  parts.push(`--${boundary}--`)
  return [
    ...baseHeaders,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    ...parts,
  ].join("\r\n")
}

function encodeRaw(rfc822: string): string {
  return Buffer.from(rfc822, "utf8").toString("base64url")
}

export async function createInThreadDraft(
  ctx: ReplyContext,
  bodyText: string,
  fromEmail: string,
  fromName?: string,
  attachments: Attachment[] = []
): Promise<string> {
  const raw = encodeRaw(
    buildRfc822(ctx, fromEmail, fromName, bodyText, attachments)
  )
  const g = await gmail()
  const r = await g.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        threadId: ctx.threadId,
      },
    },
  })
  if (!r.data.id) throw new Error("draft create returned no id")
  return r.data.id
}

export async function sendInThreadReply(
  ctx: ReplyContext,
  bodyText: string,
  fromEmail: string,
  fromName?: string,
  attachments: Attachment[] = []
): Promise<string> {
  const raw = encodeRaw(
    buildRfc822(ctx, fromEmail, fromName, bodyText, attachments)
  )
  const g = await gmail()
  const r = await g.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: ctx.threadId },
  })
  if (!r.data.id) throw new Error("send returned no id")
  return r.data.id
}

export { mimeTypeFor }

// --- Forwarding ---

/**
 * Forwards an existing message to a new recipient. Creates a DRAFT
 * forward in a NEW thread (not the original) so the original customer
 * conversation isn't polluted, and addresses go where intended.
 */
export async function createForwardDraft(
  original: ParsedMessage,
  forwardTo: string,
  fromEmail: string,
  fromName: string | undefined,
  prependBody?: string
): Promise<string> {
  const subj = original.subject.toLowerCase().startsWith("fwd:")
    ? original.subject
    : `Fwd: ${original.subject}`
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  const intro = prependBody?.trim() ? `${prependBody.trim()}\n\n` : ""
  const forwardedBlock =
    "---------- Forwarded message ----------\n" +
    `From: ${original.from}\n` +
    `Date: ${original.date.toUTCString()}\n` +
    `Subject: ${original.subject}\n` +
    `To: ${original.to.join(", ")}\n` +
    (original.cc.length ? `Cc: ${original.cc.join(", ")}\n` : "") +
    `\n` +
    original.bodyText
  const body = intro + forwardedBlock
  const rfc822 = [
    `From: ${fromHeader}`,
    `To: ${forwardTo}`,
    `Subject: ${subj}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
  ].join("\r\n")
  const raw = encodeRaw(rfc822)
  const g = await gmail()
  const r = await g.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  })
  if (!r.data.id) throw new Error("forward draft returned no id")
  return r.data.id
}

export async function sendForward(
  original: ParsedMessage,
  forwardTo: string,
  fromEmail: string,
  fromName: string | undefined,
  prependBody?: string
): Promise<string> {
  const subj = original.subject.toLowerCase().startsWith("fwd:")
    ? original.subject
    : `Fwd: ${original.subject}`
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  const intro = prependBody?.trim() ? `${prependBody.trim()}\n\n` : ""
  const forwardedBlock =
    "---------- Forwarded message ----------\n" +
    `From: ${original.from}\n` +
    `Date: ${original.date.toUTCString()}\n` +
    `Subject: ${original.subject}\n` +
    `To: ${original.to.join(", ")}\n` +
    (original.cc.length ? `Cc: ${original.cc.join(", ")}\n` : "") +
    `\n` +
    original.bodyText
  const body = intro + forwardedBlock
  const rfc822 = [
    `From: ${fromHeader}`,
    `To: ${forwardTo}`,
    `Subject: ${subj}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
  ].join("\r\n")
  const raw = encodeRaw(rfc822)
  const g = await gmail()
  const r = await g.users.messages.send({
    userId: "me",
    requestBody: { raw },
  })
  if (!r.data.id) throw new Error("forward send returned no id")
  return r.data.id
}

/** Sent messages in the same thread, used for edit-capture. */
export async function findOurSentReply(
  thread: ParsedThread,
  fromEmail: string,
  afterDate: Date
): Promise<ParsedMessage | undefined> {
  const lc = fromEmail.toLowerCase()
  return thread.messages.find(
    (m) =>
      m.from.toLowerCase().includes(lc) &&
      m.date.getTime() > afterDate.getTime() &&
      m.labelIds.includes("SENT")
  )
}
