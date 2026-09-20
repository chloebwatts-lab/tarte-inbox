# tarte-inbox

Background email automation for `hello@tarte.com.au`. It reads every email, labels it, drafts a reply inside the Gmail thread for staff to review and send, builds branded function invoices, and tells a human whenever something needs them.

Live in production since 27 May 2026 at `https://inbox.tarte.com.au`. Real customers, real money. Read "Safety rules" below before changing anything.

## Where it sits

- **Gmail (hello@)** is the staff UI. Labels and drafts simply appear there. Staff review a draft, fix it if needed, and press send.
- **tarte-inbox** (this repo) is a headless Node/TypeScript service: one Docker container on the Tarte Kitchen droplet, behind Tarte Kitchen's Caddy.
- **tarte-kitchen** (sibling repo) owns the Postgres database and hosts the admin page `/inbox-playbooks` where staff edit FAQs, house notes and the suggestion box. All tables belonging to this service are prefixed `inbox_`.
- Optional web pages served by this service: `/queue` (review and send every waiting draft from a phone) and `/invoices` (browse, edit and create invoices).

```
Gmail (hello@) ──► poll loop ──► Claude (classify, draft, extract)
                      │
                      ├──► Gmail: labels, in-thread drafts, archive, unread flags
                      ├──► Google Calendar: read team calendars, mirror bookings, pickup reminders
                      ├──► Google Drive: archive sent invoice PDFs
                      ├──► Xero (Tarte Currumbin): draft event invoices, bank feed reads
                      └──► Postgres (shared with Tarte Kitchen): playbooks, thread state, invoices, learnings
```

## Current posture (checked 20 Sep 2026)

- `ENABLE_AUTO_SEND=false` in production. Every customer reply is a draft that a human sends. Do not turn this on without Chloe's explicit say so.
- Several playbook rows in the database already have `auto_send = true` (dine in bookings, high tea, both function categories, job applications). The env flag is the only thing holding those back, so flipping it changes behaviour for all of them at once.
- Three things send email without a human click, by design:
  1. Clear job applications (classifier confidence 0.9 or higher) are forwarded to `work@tarte.com.au`.
  2. Internal mail: the 07:00 daily digest to hello@, watchdog alerts to `ALERT_EMAILS`, and event accounting notices to accounts@ and chloe@.
  3. Now Book It booking confirmations to guests (`ENABLE_BOOKING_CONFIRMATIONS`, default true). In practice nothing has ever sent, because the Now Book It daily CSV still ships blank Email and Phone columns. The moment Now Book It includes guest emails, new bookings start receiving confirmations with no code change.
- Production polls Gmail every 60 seconds (`TICK_INTERVAL_SECONDS=60` in the droplet `.env`; the code default is 120).

## What happens to an email

`runTick()` in `src/pipeline.ts` lists every inbox thread (paginated, capped at 500), skips threads whose Gmail `historyId` has not changed, and runs `processThread()` on the rest. In order:

1. Thread is in Trash: staff decided not to reply. Delete our pending draft, clear flags, stop.
2. Newest message is ours and we had drafted: record the edit distance between our draft and what staff sent (`inbox_learnings`), flip invoice labels from created to sent, archive the invoice PDF to Drive, clear Action needed.
3. Reply on a booking confirmation thread: record the acknowledgement (and any high tea answer). Plain acknowledgements are archived; questions fall through.
4. Website form relay (Squarespace and similar): parse the real customer name, email and message from the body and draft in the form thread addressed to the customer, never to the relay. Skipped if we already replied to that address in the last 14 days.
5. Classify with Claude into one of 16 categories and apply the category label. Anything mentioning tea garden or high tea also gets the Tea Garden label (staff work from that label).
6. "I have paid the deposit" claims: try to match the payment in the Xero bank feed, record it in `inbox_payments`, draft an acknowledgement with a balance invoice attached. Never claims receipt unless the bank match verified it.
7. Thread was handed to a teammate (forwarded to shawna@): no draft, but flag Action needed so a new customer reply is not lost. Invoice stage threads still get an invoice draft.
8. Bounces are flagged, never archived. Squarespace takeaway high tea orders get a label and a pickup reminder on the staff calendar.
9. Automated receipts and no-reply mail are archived. Confident `no_action` and `marketing_cold_outreach` (0.75 or higher) are archived. A new reply brings a thread back.
10. `urgent_escalation` is never drafted: `Tarte / URGENT` plus Action needed.
11. Categories with a `forward_to` playbook address (job applications) are forwarded or, below the confidence bar, left on the queue with a one tap Forward button.
12. Function enquiries (Tea Garden functions, Beach House functions) go through `handleFunctionEnquiry()`: read the team calendars for the requested date (including all day events), draft a short reply that refers to the functions pack, always flag a human. The agent never proposes time slots of its own. When the thread shows a confirmed private hire with a quoted price, date and guest count, it builds a deposit invoice draft.
13. `needs_human`, `accounts_invoices` and `suppliers` are label only plus Action needed. Known supplier senders can never receive a drafted reply (hard guard in `deliver()`).
14. Everything else is drafted: playbook (voice, template, examples, FAQ), the full thread, the customer's other threads from the last year, their Now Book It bookings for existing booking emails, the Tarte Kitchen allergen matrix when dietary words appear, and live house notes. The draft lands in the thread, the thread is marked unread and labelled Action needed.

Rules that hold in every drafting path:

- The model always gets the entire thread and the customer's other threads (`renderFullThread`, `fetchCustomerHistory`). Never add a small `.slice()` to text feeding the model.
- Hard business facts live in `BUSINESS_FACTS` in `src/llm/drafter.ts` and win over playbooks and house notes. Code guards run after the model: `enforceSignoff()` ("Kind Regards," then "Tarte Management") and `debot()` (strips em dashes and similar tells).
- Allergen questions, floor layout checks and anything flagged `needs_human` can never auto-send, whatever the flags say.

## Categories and labels

Category labels: `Events / Tea Garden - High Tea`, `Events / Tea Garden - Functions`, `Events / Beach House - Functions`, `Suppliers`, `Reviews`, `Bookings`, `Bookings / Existing`, `Orders / Cakes & Catering`, `General enquiries`, `Donations / Fundraisers`, `Job applications`, `Marketing / Cold outreach`, `Accounts / Invoices`, `URGENT`, `No action`, `Needs human`.

Status labels the service applies: `Tarte / Action needed`, `Tarte / URGENT`, `Tarte / Auto-handled`, `Tarte / Invoice created`, `Tarte / Invoice sent`, `Tarte / Takeaway High Tea`, `Tarte / 12+ booking`, `Tarte / Missed`, `Tarte / Booking Confirmations`.

Labels staff apply to give the service an instruction (it removes the label when done):

| Label | What it does |
|---|---|
| `Tarte / Make Invoice` | Extract the final agreed details from the thread and draft the branded invoice. If a required detail is missing it leaves an internal note draft saying exactly what to add. If an invoice already exists it rebuilds it. |
| `Tarte / Update Invoice` | Re-read the thread and rebuild every invoice on it (deposit and balance stay in step). Keeps the staffer's draft wording and swaps the PDF. |
| `Tarte / Cancel Function` | Mark the booking cancelled, tidy the Xero draft, brief accounts@ and chloe@. |

Staff tip that the extractor relies on: prices or deposits agreed by phone must be typed into the thread. The usual way is to forward the thread to hello@ with the instruction on top ("needs $500 save the date invoice for Hideout high tea 6 December"), then apply `Tarte / Make Invoice`. It cannot read PDF attachments yet.

## Invoices

- Own PDF generator (`src/invoice/generate.ts`, pdfkit): deposit, balance, table booking, flat save-the-date and paid in full layouts. Numbers are `TARTE-YYYY-NNNNN`, idempotent per thread and kind. PDF bytes and the editable detail are stored in `inbox_invoices`.
- Invoice emails are always drafts, BCC shawna@, accounts@ and the bookkeeper, with the event date and invoice number tagged on the subject.
- Each event thread is mirrored as one DRAFT invoice in Xero dated the event day, so revenue lands on the event date. The bookkeeper approves it in Xero. `ENABLE_AUTO_INVOICE` (default false) gates the old path that created authorised Xero invoices on slot confirmation. Leave it off.
- Portal pages, gated by `INVOICE_PORTAL_TOKEN` (open once with `?k=<token>`, a cookie then lasts 60 days; links in the daily digest carry the key): `/invoices`, `/invoice/new`, `/invoice/edit?n=<number>`. Editing regenerates the PDF and refreshes the draft in Gmail. Nothing on these pages sends an email.
- Sent invoice PDFs are meant to be archived to Google Drive when staff send the draft, with an hourly retry. As at 20 Sep 2026 this is dormant: the stored Google grant has no `drive.file` scope, so `driveReady()` is false and nothing uploads. One visit to `/oauth/google/start` signed in as hello@ switches it on. The PDF bytes are kept in `inbox_invoices` either way.
- The daily digest opens with an event payments section read from the Xero bank feed. A payment is only marked verified when the payer name overlaps the customer name. Amount only matches are shown as "possible", never stored.

## Review queue

`/queue` (same portal token) lists every pending draft with Send, Edit in Gmail and Dismiss, plus a "Needs a look" list of flagged threads with no draft (Done, Forward). Drafts without attachments can be edited on the page. Every send on this page is a human click. `/queue/thread?t=<id>` shows the whole conversation.

## Schedules (`src/scheduler.ts`)

| Every | What |
|---|---|
| `TICK_INTERVAL_SECONDS` | Email tick, then the Make Invoice, Update Invoice and Cancel Function label sweeps |
| 10 min | Re-mark threads with a pending draft as unread. A sent reply or a deleted draft counts as handled. |
| 10 min check, fires once after 07:00 Brisbane | Xero keepalive, one nudge draft for stale function bookings, one follow up draft for quiet function info threads, day after event close out sweep, daily digest to hello@ |
| 15 min | Watchdog quick checks |
| 60 min | Now Book It CSV ingest (last 7 days), booking confirmations, combined calendar sync, Drive archive retry, spam rescue, coverage sentinel |

On Mondays the digest run also writes learning proposals from staff edits (`inbox_learning_notes`). They appear in the digest and are never applied automatically.

## Watchdog and coverage sentinel

`src/health.ts` keeps one row per check in `inbox_health` and emails `ALERT_EMAILS` when a check goes from ok to failing, with a fix that can be done from a phone (usually a re-auth link), then again on recovery. Checks: `google_gmail`, `xero_link`, `xero_api`, `ticks`, `digest`, `coverage`, `stale_drafts`.

`src/coverage.ts` is the outcome check: no customer message may sit unanswered without a human being told. It lists the inbox with its own Gmail query and pagination, independent of the pipeline. A thread is covered when our reply is newest, a draft is pending, or it carries Action needed or URGENT. Uncovered customer mail older than 4 hours fails the `coverage` check. Drafts unsent for 2 days fail `stale_drafts`. It also maintains the `Tarte / Missed` folder. `runCoverageAudit({ dryRun: true })` reports without labels or alerts (`dist/scripts/coverage-audit.js`).

## HTTP endpoints

Public at the proxy: `/health`, `/oauth/google/start`, `/oauth/xero/start` and their callbacks. Token gated in the app: `/invoices`, `/invoice/*`, `/queue`, `/queue/*`. Everything else sits behind Caddy basic auth (the shared `tarte` login): `/status`, `/playbooks`, `POST /tick`, `POST /sync-nbi`, `POST /digest/run`, `POST /followups/run`, `POST /calendar-sync/run`, `POST /thread/:id/redraft`, `GET /thread/find`, `POST /booking/:id/invoice`.

`/status` shows whether Google and Xero are linked, the granted scopes, and the live `auto_send` value.

## Database

Schema lives in `src/db/schema.sql` and is applied on every boot by `migrate()`. It is written to be re-runnable (`CREATE TABLE IF NOT EXISTS`, additive `ALTER`). Tables: `inbox_oauth_tokens`, `inbox_threads`, `inbox_playbooks`, `inbox_nbi_bookings`, `inbox_nbi_confirmations`, `inbox_bookings`, `inbox_learnings`, `inbox_learning_notes`, `inbox_invoices`, `inbox_payments`, `inbox_health`, `inbox_digest_log`, `inbox_allergen_assessments`, `inbox_house_notes`, `inbox_runs`.

Two lessons already paid for: in an upsert never write `EXCLUDED.col` for an optional field (it wiped Xero tenants and reset thread states), and timestamps in `inbox_learnings` are `noted_at`.

## Code map

| Path | Purpose |
|---|---|
| `src/index.ts` | Boot: migrate, HTTP server, scheduler |
| `src/pipeline.ts` | The tick, `processThread`, forms, forwards, `deliver`, invoices by label, queue actions, unread sweep, edit capture |
| `src/llm/` | Classifier, drafter (business facts and guards), booking and invoice helpers, deposit paid check, booking acknowledgement parser, weekly learning synthesis. Model id is in `src/llm/client.ts`. |
| `src/invoice/` | PDF generator, thread to invoice extraction, cancellation and post event sweep |
| `src/google/` | Gmail, OAuth, Calendar, combined calendar sync, Drive, customer history |
| `src/nbi/` | Now Book It CSV ingest and booking confirmations |
| `src/xero/` | Xero client, keepalive, event drafts, bank feed payment matching |
| `src/tk/allergens.ts` | Dish to ingredient allergen rollup from Tarte Kitchen data |
| `src/coverage.ts`, `src/health.ts`, `src/digest.ts`, `src/followups.ts` | Sentinel, watchdog, daily digest, nudges |
| `src/scripts/` | Ops, test and one-off scripts, compiled to `dist/scripts/` |

## Ops scripts

Run inside the container: `docker compose exec -T inbox node dist/scripts/<name>.js`. The repo is public, so customer names are passed as arguments and never committed.

Read only: `scan-issues`, `coverage-audit`, `diagnose-drafts`, `debug-thread`, `test-extract-thread` (what Make Invoice would do), `preview-drafts`, `scan-attachments`, `find-event-deposits`, `test-xero`, `test-form-parse`, `test-synthetic`, `test-invoice`, `ingest-sent --dry-run`.

Dry run by default, `--apply` to act: `tidy-labels`, `delete-orphan-drafts`, `restore-nowbookit`, `repair-thread-states`.

Write on run, check with Chloe first: `seed-playbooks` (overwrites every playbook, never run on prod), `ingest-sent` without `--dry-run` (overwrites the example replies on every playbook, and since go live most sent mail started life as an agent draft), `regenerate-examples`, `update-tone`, `thread-ops`, `draft-reply`, and the dated `update-*` one-offs.

## Local development

```bash
npm install
cp .env.example .env
npm run typecheck
```

Do not run `npm run dev` or `npm run tick` against the production database and mailbox. A second poller races the live one and creates duplicate drafts. For read only checks against production, write a script that only reads, or use the scripts above on the droplet.

## Safety rules

1. Auto-send stays off unless Chloe says otherwise. Never flip it as a side effect.
2. Drafts, not sends. New customer facing paths must draft and flag a human.
3. Additive changes only on the database. No deletes, drops or bulk overwrites without per action confirmation.
4. No em dashes in anything a customer could read. Crullers, never churros. No comps or vouchers. Not open for dinner. Sign off is "Kind Regards," then "Tarte Management".
5. Every new env var must be added to `docker-compose.yml` as well as `.env`, or the container never sees it.
6. Every new integration registers a watchdog check with a phone friendly fix.
7. Secrets live only in `.env` files. Never in git, chat or logs.

Deployment and recovery are in `DEPLOY.md`. A primer for a fresh Claude session is in `docs/GEORGIA-ONBOARDING.md`.
