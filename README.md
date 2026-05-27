# tarte-inbox

Background email automation for `hello@tarte.com.au`. Triages, labels, drafts replies, checks calendars, and creates Xero invoices for function bookings. No user-facing UI of its own — staff continue to use Gmail.

## How it fits

- **Gmail** — the only thing Shauna and Georgia ever touch. Labels appear automatically, drafts appear in-thread, high-confidence replies auto-send.
- **tarte-inbox** (this repo) — invisible background service. Polls Gmail, calls Claude to classify and draft, talks to Google Calendar + Xero.
- **tarte-kitchen** (sibling repo) — hosts the admin UI for editing playbooks and viewing what got auto-handled. Shares Postgres with this service.

## Status

Scaffold only. Nothing functional yet. Next steps below.

## Architecture

```
Gmail (hello@) ──► tarte-inbox poll loop ──► Claude (classify + draft)
                            │
                            ├──► Google Calendar (read for conflict checks, write to lock events)
                            ├──► Xero (Tarte Currumbin Pty Ltd — invoices)
                            └──► Postgres (shared with TK — playbooks, run history, learnings)
```

## Categories (first cut)

| Label | Action |
|---|---|
| `Events / Tea Garden - High Tea` | Mostly self-serve via Now Book It; if it arrives by email, redirect to NBI booking widget |
| `Events / Tea Garden - Functions` | >12 pax: draft holding reply ("checking availability, back to you within the day") until NBI sync exists |
| `Events / Beach House - Functions` | Full pipeline: check calendar → propose slots → on confirm, draft Xero deposit invoice → send |
| `Suppliers` | Auto-draft in-thread |
| `Reviews` | Auto-draft (or auto-send acknowledgements once trusted) |
| `Bookings` (regular dine-in) | Should be NBI — flag if it lands here |
| `Job applications` | Auto-draft acknowledgement, file for human review |
| `Marketing / Cold outreach` | Auto-archive candidate |
| `Accounts / Invoices` | Forward / label only |
| `Needs human` | Low-confidence default |

## Auto-send vs auto-draft

Launch posture: `ENABLE_AUTO_SEND=false`. Everything drafts in-thread for 1-2 weeks so Shauna and Georgia can verify tone and accuracy. Promote categories one-by-one to auto-send as trust builds.

## Now Book It

Confirmed (2026-05-27) that NBI offers no self-serve Google Calendar / iCal sync. Their public integrations are POS, payments, social, and Function Tracker only. Two paths kept open:

1. **Launch without NBI** — Tea Garden function timing deferred to human (current plan).
2. **Pursue NBI partner API** — email `enquiries@nowbookit.com`. Not blocking.

## Phases

- **P0 — Scaffold** (this commit): repo bones, env shape, no logic.
- **P1 — Read-only**: Gmail OAuth, poll loop, classification, label application. No replies yet. Watch what it labels for ~3 days.
- **P2 — In-thread drafts**: drafting layer, drafts appear in-thread (not in /Drafts). Still no auto-send.
- **P3 — Beach House function pipeline**: calendar conflict check + slot proposals + Xero deposit invoice draft.
- **P4 — Auto-send promotion**: promote low-risk categories (booking confirmations, review acks) to auto-send once trusted.
- **P5 — Tea Garden function support**: full pipeline once NBI availability is solved.

## What this repo will NOT do

- Replicate Fyxer feature-for-feature (no meeting notes, no cross-mailbox unified view).
- Have its own UI. Gmail is the UI. TK admin is where playbooks are edited.
- Handle regular dine-in bookings — those stay in Now Book It.

## Local dev (once env is filled in)

```bash
npm install
cp .env.example .env  # fill in real values
npm run dev
```

## Deploy

Same host as tarte-kitchen. See `tarte_deploy.md` in user memory for SSH target + `deploy.sh` flow once a deploy script is added here.
