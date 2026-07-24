# Tarte Inbox — onboarding primer for Claude (Georgia's account)

Paste this whole file as your first message to Claude Code when you open this repo. It gives Claude the context it needs, because a fresh Claude account starts with zero memory of this project.

---

You are helping Georgia work on **Tarte Inbox**, a live production email-automation service for Tarte (a Gold Coast café/restaurant group). Read this whole primer before doing anything. Then confirm back to me what you understand and ask what I want to change — do not start editing yet.

## What this project is

- A **headless Node/TypeScript service** that runs the `hello@tarte.com.au` inbox automatically: it reads every email, classifies it, labels it in Gmail, and drafts a reply in-thread for staff to review. It also handles function-booking enquiries and generates branded deposit/balance invoice PDFs.
- **Gmail is the only UI.** Staff (Georgia, Shawna) never leave Gmail — labels and drafts just appear there. This service is invisible background infrastructure. Never propose building a separate UI.
- It is **deliberately separate** from the sibling "Tarte Kitchen" (TK) repo, but shares TK's Postgres database (tables prefixed `inbox_`). TK hosts an admin page at `/inbox-playbooks` for editing playbook wording without code changes.
- It's **deployed on a DigitalOcean droplet** alongside TK, behind Caddy, live at `https://inbox.tarte.com.au`. It polls Gmail every couple of minutes.

## This is LIVE and SHARED — the rules that protect it

1. **Real customers, real money.** Every change can affect emails going to real people and invoices with real bank details. Move carefully. When in doubt, make a draft, not an auto-send; flag for a human rather than guess.
2. **This repo is shared with Chloe (accounts@tarte).** She works on it too. ALWAYS `git pull` before you start and `git push` when you finish. Tell Chloe before deploying — a bad deploy takes the whole inbox down for everyone. Never assume you're the only one touching it.
3. **Never re-enable auto-send (`ENABLE_AUTO_SEND`) without Chloe's explicit say-so.** Check the current state first; do not flip it as a side effect of another change.
4. **Additive over destructive.** Adding FAQs, business facts, guard rules = fine. Deleting data, dropping tables, bulk-overwriting playbooks, or mass-editing the database = stop and get explicit confirmation first.
5. **Secrets live only in `.env` on this machine and on the droplet — never in git, never in chat, never in a commit.** If a task seems to need a secret value, ask Georgia to supply/apply it; don't print it.

## Standing content rules (these are HARD — never violate in any customer-facing text)

- **No AI tells. No em dashes.** Ever. Not in FAQs, drafts, templates, or anything a customer might read.
- Tarte sells **crullers, never "churros."** Never write "churro."
- **Never offer free goods, vouchers, or comps.** On pricing complaints, gently push back — Tarte is below market given daily on-site production and ingredient quality.
- **Sign-off is exactly:** `Kind Regards,` newline `Tarte Management`. Never "Tarte Team," never lowercase.
- **Not open for dinner** (as of mid-2026). Answer dinner questions with "not yet, but watch this space." No evening slots, ever.
- **Read the ENTIRE email thread + the customer's other threads before drafting or extracting anything.** Never truncate what feeds the model. Numbers/dates change mid-thread — always take the most recent agreed values. This is enforced in code (`renderFullThread`, `fetchCustomerHistory`); any new drafting path must keep it.
- **Group table booking ≠ private function.** A big group just wanting a table is normal dining (no deposit, no invoice). Deposits + packages + invoices are for exclusive private hire only.
- **The agent no longer proposes specific time slots** — it only sees part of the calendar, so it confirms the customer's own requested time, refers to the functions pack, and flags a human to check the real shared calendar.

## How the code is laid out (verify before relying on any path — this primer may be stale)

- `src/` — the service. Key areas: classification + drafting (LLM prompts hold the BUSINESS_FACTS block), `src/invoice/` (PDF generation), `src/google/` (Gmail + Calendar + Drive), `src/tk/` (allergen rollups from TK data), `scripts/` (one-off maintenance + tests).
- Playbooks, FAQs, run history, learnings, invoices, payments = in Postgres, `inbox_*` tables. Much of this is editable via TK's `/inbox-playbooks` admin page **without a code change** — prefer that for pure wording changes.
- `README.md`, `DEPLOY.md` — start here. `docker-compose.yml` — note: every env var must be listed here explicitly, not just in `.env`, or the container won't see it.

## The workflow for any change

1. `git pull` (get Chloe's latest first).
2. Make the change. Match the surrounding code's style.
3. `npx tsc --noEmit` (or the project's build) — must be clean.
4. Run the relevant test script in `scripts/` if one exists; add a synthetic check for anything customer-facing.
5. `git commit` + `git push`.
6. Deploy only per the agreed rule (tell Chloe / or she deploys): the droplet deploy is via `ssh` + `./scripts/deploy.sh` — see `DEPLOY.md`. Never end a session "pushed but not deployed" without saying so explicitly.
7. Verify live: `/health` returns ok, the scheduler tick is clean, and `ENABLE_AUTO_SEND` is what you expect.

## Now

Confirm you've read this, tell me in one paragraph what Tarte Inbox is and the top 3 rules you'll never break, then ask me what I'd like to change today. Do not edit anything yet.
