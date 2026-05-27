-- tarte-inbox schema. Lives in the shared tarte Postgres alongside TK tables.
-- All tables are prefixed `inbox_` so they don't collide with TK's schema.

CREATE TABLE IF NOT EXISTS inbox_oauth_tokens (
  provider          text PRIMARY KEY,                 -- 'google' | 'xero'
  access_token      text NOT NULL,
  refresh_token     text,
  scope             text,
  token_type        text,
  expiry            timestamptz,
  extra             jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Tracks every thread we've touched so we don't re-classify endlessly.
-- We re-process a thread only when historyId / last_message_id changes.
CREATE TABLE IF NOT EXISTS inbox_threads (
  thread_id         text PRIMARY KEY,
  last_message_id   text NOT NULL,
  last_history_id   text,
  category          text,
  confidence        real,
  state             text NOT NULL DEFAULT 'classified',
  last_action       text,
  last_processed_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS inbox_threads_state_idx ON inbox_threads(state);
CREATE INDEX IF NOT EXISTS inbox_threads_category_idx ON inbox_threads(category);

-- Per-category playbook. Editable from TK admin (later).
CREATE TABLE IF NOT EXISTS inbox_playbooks (
  category          text PRIMARY KEY,
  description       text NOT NULL,
  voice_guidance    text NOT NULL,                   -- "how Chloe writes"
  reply_template    text,                            -- optional skeleton
  auto_send         boolean NOT NULL DEFAULT false,  -- can this category auto-send?
  min_confidence    real NOT NULL DEFAULT 0.85,      -- threshold for auto-action
  examples          jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{incoming, reply}]
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Function booking state machine (Beach House + Tea Garden >12 pax).
CREATE TABLE IF NOT EXISTS inbox_bookings (
  id                bigserial PRIMARY KEY,
  thread_id         text NOT NULL REFERENCES inbox_threads(thread_id) ON DELETE CASCADE,
  venue             text NOT NULL,                   -- 'tea_garden' | 'beach_house'
  state             text NOT NULL,                   -- enquiry_received | slots_proposed | slot_selected | deposit_invoiced | deposit_paid | balance_invoiced | paid | cancelled
  customer_email    text,
  customer_name     text,
  pax               int,
  proposed_slots    jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_at      timestamptz,
  event_date        date,
  event_start       timestamptz,
  event_end         timestamptz,
  calendar_event_id text,
  xero_contact_id   text,
  xero_deposit_invoice_id  text,
  xero_balance_invoice_id  text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_bookings_thread_idx ON inbox_bookings(thread_id);
CREATE INDEX IF NOT EXISTS inbox_bookings_state_idx ON inbox_bookings(state);

-- Captures the diff between what we drafted and what the human ultimately sent.
-- Feeds back into playbook refinement.
CREATE TABLE IF NOT EXISTS inbox_learnings (
  id                bigserial PRIMARY KEY,
  thread_id         text NOT NULL,
  category          text,
  our_draft         text NOT NULL,
  sent_reply        text NOT NULL,
  edit_distance     int,
  noted_at          timestamptz NOT NULL DEFAULT now()
);

-- Audit log of every run.
CREATE TABLE IF NOT EXISTS inbox_runs (
  id                bigserial PRIMARY KEY,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  threads_seen      int NOT NULL DEFAULT 0,
  threads_acted     int NOT NULL DEFAULT 0,
  error             text
);
