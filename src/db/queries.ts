import { db } from "./pool.js"

// --- OAuth tokens ---

export interface StoredTokens {
  provider: string
  access_token: string
  refresh_token: string | null
  scope: string | null
  token_type: string | null
  expiry: Date | null
  extra: Record<string, unknown>
}

export async function getTokens(
  provider: "google" | "xero"
): Promise<StoredTokens | null> {
  const r = await db().query<StoredTokens>(
    `SELECT provider, access_token, refresh_token, scope, token_type, expiry, extra
       FROM inbox_oauth_tokens WHERE provider = $1`,
    [provider]
  )
  return r.rows[0] ?? null
}

export async function saveTokens(t: {
  provider: "google" | "xero"
  access_token: string
  refresh_token?: string | null
  scope?: string | null
  token_type?: string | null
  expiry?: Date | null
  extra?: Record<string, unknown>
}): Promise<void> {
  await db().query(
    `INSERT INTO inbox_oauth_tokens (provider, access_token, refresh_token, scope, token_type, expiry, extra, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (provider) DO UPDATE
       SET access_token  = EXCLUDED.access_token,
           refresh_token = COALESCE(EXCLUDED.refresh_token, inbox_oauth_tokens.refresh_token),
           scope         = COALESCE(EXCLUDED.scope, inbox_oauth_tokens.scope),
           token_type    = COALESCE(EXCLUDED.token_type, inbox_oauth_tokens.token_type),
           expiry        = EXCLUDED.expiry,
           extra         = EXCLUDED.extra,
           updated_at    = now()`,
    [
      t.provider,
      t.access_token,
      t.refresh_token ?? null,
      t.scope ?? null,
      t.token_type ?? null,
      t.expiry ?? null,
      t.extra ?? {},
    ]
  )
}

// --- Thread tracking ---

export interface ThreadRow {
  thread_id: string
  last_message_id: string
  last_history_id: string | null
  category: string | null
  confidence: number | null
  state: string
  last_action: string | null
  last_processed_at: Date
  meta: Record<string, unknown>
}

export async function getThread(threadId: string): Promise<ThreadRow | null> {
  const r = await db().query<ThreadRow>(
    `SELECT * FROM inbox_threads WHERE thread_id = $1`,
    [threadId]
  )
  return r.rows[0] ?? null
}

export async function upsertThread(t: {
  thread_id: string
  last_message_id: string
  last_history_id?: string | null
  category?: string | null
  confidence?: number | null
  state?: string
  last_action?: string | null
  meta?: Record<string, unknown>
}): Promise<void> {
  await db().query(
    `INSERT INTO inbox_threads
       (thread_id, last_message_id, last_history_id, category, confidence, state, last_action, last_processed_at, meta)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'classified'), $7, now(), COALESCE($8, '{}'::jsonb))
     ON CONFLICT (thread_id) DO UPDATE
       SET last_message_id   = EXCLUDED.last_message_id,
           last_history_id   = EXCLUDED.last_history_id,
           category          = COALESCE(EXCLUDED.category, inbox_threads.category),
           confidence        = COALESCE(EXCLUDED.confidence, inbox_threads.confidence),
           state             = COALESCE(EXCLUDED.state, inbox_threads.state),
           last_action       = COALESCE(EXCLUDED.last_action, inbox_threads.last_action),
           last_processed_at = now(),
           meta              = inbox_threads.meta || EXCLUDED.meta`,
    [
      t.thread_id,
      t.last_message_id,
      t.last_history_id ?? null,
      t.category ?? null,
      t.confidence ?? null,
      t.state ?? null,
      t.last_action ?? null,
      t.meta ?? null,
    ]
  )
}

// --- Playbooks ---

export interface Playbook {
  category: string
  description: string
  voice_guidance: string
  reply_template: string | null
  auto_send: boolean
  min_confidence: number
  examples: Array<{ incoming: string; reply: string }>
  default_attachment_paths: string[]
  forward_to: string | null
}

export async function getPlaybook(category: string): Promise<Playbook | null> {
  const r = await db().query<Playbook>(
    `SELECT category, description, voice_guidance, reply_template,
            auto_send, min_confidence, examples,
            COALESCE(default_attachment_paths, '[]'::jsonb) AS default_attachment_paths,
            forward_to
       FROM inbox_playbooks WHERE category = $1`,
    [category]
  )
  return r.rows[0] ?? null
}

export async function listPlaybooks(): Promise<Playbook[]> {
  const r = await db().query<Playbook>(
    `SELECT category, description, voice_guidance, reply_template,
            auto_send, min_confidence, examples,
            COALESCE(default_attachment_paths, '[]'::jsonb) AS default_attachment_paths,
            forward_to
       FROM inbox_playbooks ORDER BY category`
  )
  return r.rows
}

export async function upsertPlaybook(p: Playbook): Promise<void> {
  await db().query(
    `INSERT INTO inbox_playbooks
       (category, description, voice_guidance, reply_template, auto_send,
        min_confidence, examples, default_attachment_paths, forward_to, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9, now())
     ON CONFLICT (category) DO UPDATE
       SET description              = EXCLUDED.description,
           voice_guidance            = EXCLUDED.voice_guidance,
           reply_template            = EXCLUDED.reply_template,
           auto_send                 = EXCLUDED.auto_send,
           min_confidence            = EXCLUDED.min_confidence,
           examples                  = EXCLUDED.examples,
           default_attachment_paths  = EXCLUDED.default_attachment_paths,
           forward_to                = EXCLUDED.forward_to,
           updated_at                = now()`,
    [
      p.category,
      p.description,
      p.voice_guidance,
      p.reply_template,
      p.auto_send,
      p.min_confidence,
      JSON.stringify(p.examples),
      JSON.stringify(p.default_attachment_paths ?? []),
      p.forward_to ?? null,
    ]
  )
}

// --- Bookings ---

export interface BookingRow {
  id: number
  thread_id: string
  venue: "tea_garden" | "beach_house"
  state: string
  customer_email: string | null
  customer_name: string | null
  pax: number | null
  proposed_slots: Array<{ start: string; end: string }>
  confirmed_at: Date | null
  event_date: Date | null
  event_start: Date | null
  event_end: Date | null
  calendar_event_id: string | null
  xero_contact_id: string | null
  xero_deposit_invoice_id: string | null
  xero_balance_invoice_id: string | null
  notes: string | null
}

export async function getBookingByThread(
  threadId: string
): Promise<BookingRow | null> {
  const r = await db().query<BookingRow>(
    `SELECT * FROM inbox_bookings WHERE thread_id = $1 ORDER BY id DESC LIMIT 1`,
    [threadId]
  )
  return r.rows[0] ?? null
}

export async function insertBooking(b: {
  thread_id: string
  venue: "tea_garden" | "beach_house"
  state: string
  customer_email?: string | null
  customer_name?: string | null
  pax?: number | null
  proposed_slots?: Array<{ start: string; end: string }>
  notes?: string | null
}): Promise<number> {
  const r = await db().query<{ id: number }>(
    `INSERT INTO inbox_bookings
       (thread_id, venue, state, customer_email, customer_name, pax, proposed_slots, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     RETURNING id`,
    [
      b.thread_id,
      b.venue,
      b.state,
      b.customer_email ?? null,
      b.customer_name ?? null,
      b.pax ?? null,
      JSON.stringify(b.proposed_slots ?? []),
      b.notes ?? null,
    ]
  )
  const row = r.rows[0]
  if (!row) throw new Error("insertBooking: no id returned")
  return row.id
}

export async function updateBooking(
  id: number,
  patch: Partial<{
    state: string
    proposed_slots: Array<{ start: string; end: string }>
    event_date: string
    event_start: Date
    event_end: Date
    calendar_event_id: string
    xero_contact_id: string
    xero_deposit_invoice_id: string
    xero_balance_invoice_id: string
    notes: string
  }>
): Promise<void> {
  const fields: string[] = []
  const values: unknown[] = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (k === "proposed_slots") {
      fields.push(`${k} = $${i}::jsonb`)
      values.push(JSON.stringify(v))
    } else {
      fields.push(`${k} = $${i}`)
      values.push(v)
    }
    i++
  }
  if (!fields.length) return
  fields.push(`updated_at = now()`)
  values.push(id)
  await db().query(
    `UPDATE inbox_bookings SET ${fields.join(", ")} WHERE id = $${i}`,
    values
  )
}

// --- Learnings ---

export async function recordLearning(l: {
  thread_id: string
  category: string | null
  our_draft: string
  sent_reply: string
  edit_distance: number
}): Promise<void> {
  await db().query(
    `INSERT INTO inbox_learnings (thread_id, category, our_draft, sent_reply, edit_distance)
     VALUES ($1,$2,$3,$4,$5)`,
    [l.thread_id, l.category, l.our_draft, l.sent_reply, l.edit_distance]
  )
}

// --- Runs ---

export async function startRun(): Promise<number> {
  const r = await db().query<{ id: number }>(
    `INSERT INTO inbox_runs DEFAULT VALUES RETURNING id`
  )
  const row = r.rows[0]
  if (!row) throw new Error("startRun: no id returned")
  return row.id
}

export async function finishRun(
  id: number,
  stats: { threads_seen: number; threads_acted: number; error?: string }
): Promise<void> {
  await db().query(
    `UPDATE inbox_runs
        SET finished_at = now(), threads_seen = $2, threads_acted = $3, error = $4
      WHERE id = $1`,
    [id, stats.threads_seen, stats.threads_acted, stats.error ?? null]
  )
}
