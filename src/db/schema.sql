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

-- Filenames (relative to /app/attachments inside the container) to attach
-- on the FIRST reply we send in a thread. Empty array = no auto-attach.
ALTER TABLE inbox_playbooks
  ADD COLUMN IF NOT EXISTS default_attachment_paths jsonb NOT NULL DEFAULT '[]'::jsonb;

-- When non-NULL, instead of drafting a reply to the original sender, the
-- agent forwards the incoming email to this address. Used for categories
-- that always get handed to another team (e.g. job_applications → work@).
ALTER TABLE inbox_playbooks
  ADD COLUMN IF NOT EXISTS forward_to text;

-- Per-category FAQ / cheat sheet. Array of {question, answer} pairs the
-- agent reads as authoritative facts when drafting. Questions with an
-- empty answer are flagged in the admin UI for Shawna/Chloe to fill in.
ALTER TABLE inbox_playbooks
  ADD COLUMN IF NOT EXISTS faq jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Now Book It bookings, ingested from the daily summary CSV email.
-- One row per booking reference. Re-ingesting overwrites the row so
-- status / payment changes flow through.
CREATE TABLE IF NOT EXISTS inbox_nbi_bookings (
  booking_ref       text PRIMARY KEY,
  booking_date      date NOT NULL,
  booking_time      time NOT NULL,
  service           text NOT NULL,   -- e.g. "Tea Garden High Tea", "Restaurant Menu"
  pax               int NOT NULL,
  first_name        text,
  last_name         text,
  email             text,
  phone             text,
  notes             text,
  tags              text,
  status            text NOT NULL,   -- "Confirmed" / "Unconfirmed" / "Cancelled" / "Seated"
  seat_location     text,            -- e.g. "Main Dining Room", "Tea Garden (next door)"
  booked_at         timestamptz,
  last_modified_at  timestamptz,
  payment_type      text,
  total_amount      numeric(10,2),
  ingested_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbox_nbi_bookings_date_idx
  ON inbox_nbi_bookings(booking_date) WHERE status != 'Cancelled';
CREATE INDEX IF NOT EXISTS inbox_nbi_bookings_service_idx
  ON inbox_nbi_bookings(service);

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

-- One nudge per stale booking: set when we draft a follow-up to a customer
-- who went quiet after we proposed slots.
ALTER TABLE inbox_bookings
  ADD COLUMN IF NOT EXISTS nudged_at timestamptz;

-- One follow-up per thread that received generic function info but went quiet,
-- asking if we can help get the function booked. Set when that nudge is drafted.
ALTER TABLE inbox_threads
  ADD COLUMN IF NOT EXISTS info_followed_up_at timestamptz;

-- Tarte-issued deposit invoices (our own PDF, not Xero). One row per invoice;
-- the bigserial id forms the human invoice number (PREFIX-YYYY-000123).
CREATE TABLE IF NOT EXISTS inbox_invoices (
  id                bigserial PRIMARY KEY,
  invoice_number    text UNIQUE NOT NULL,
  booking_id        bigint REFERENCES inbox_bookings(id) ON DELETE SET NULL,
  thread_id         text,
  customer_name     text,
  customer_email    text,
  amount            numeric(10,2) NOT NULL,
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Keep the generated PDF bytes so we can upload a copy to Google Drive once the
-- invoice draft is actually sent by a human (detected via edit-capture).
-- drive_file_id is set after a successful upload so it's idempotent + retryable.
ALTER TABLE inbox_invoices
  ADD COLUMN IF NOT EXISTS pdf_bytes         bytea,
  ADD COLUMN IF NOT EXISTS drive_file_id     text,
  ADD COLUMN IF NOT EXISTS drive_uploaded_at timestamptz;

-- kind distinguishes the deposit/standard invoice from a later balance invoice
-- (remaining 50% once the deposit is paid) so the two get separate numbers and
-- are idempotent independently. editable stores the extracted booking details
-- so staff can tweak a field and regenerate the PDF (the quick-amend form).
ALTER TABLE inbox_invoices
  ADD COLUMN IF NOT EXISTS kind     text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS editable jsonb;

-- Record of guest payment confirmations. A guest tells us they've paid → we
-- log a 'claimed' row; once a matching bank transaction is found in Xero it
-- becomes 'verified'; 'unmatched' means we couldn't find it yet (human checks).
CREATE TABLE IF NOT EXISTS inbox_payments (
  id                   bigserial PRIMARY KEY,
  thread_id            text NOT NULL,
  invoice_number       text,
  booking_id           bigint REFERENCES inbox_bookings(id) ON DELETE SET NULL,
  amount               numeric(10,2),
  status               text NOT NULL DEFAULT 'claimed', -- claimed | verified | unmatched
  matched_txn_id       text,
  matched_reference    text,
  claimed_at           timestamptz NOT NULL DEFAULT now(),
  verified_at          timestamptz,
  confirmation_drafted_at timestamptz
);
CREATE INDEX IF NOT EXISTS inbox_payments_thread_idx ON inbox_payments(thread_id);

-- One row per daily digest sent, keyed by Brisbane calendar date.
CREATE TABLE IF NOT EXISTS inbox_digest_log (
  sent_date         date PRIMARY KEY,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Tracks which TK ingredients have had their allergens assessed (and how).
-- The allergen tags themselves live on TK's "Ingredient".allergens so staff
-- can see/correct them in the TK UI; this table only records coverage, so
-- "no allergens tagged" can be distinguished from "never assessed".
-- An ingredient only counts as covered when confident = true.
CREATE TABLE IF NOT EXISTS inbox_allergen_assessments (
  ingredient_id     text PRIMARY KEY,
  ingredient_name   text NOT NULL,
  allergens         jsonb NOT NULL DEFAULT '[]'::jsonb,
  confident         boolean NOT NULL,
  rationale         text,
  assessed_at       timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL DEFAULT 'llm'   -- 'llm' | 'human'
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
