# tarte-inbox deployment runbook

The service is live. This file covers routine deploys, checks, rollback and recovery. The one-time setup is kept at the bottom for a rebuild.

## Where it runs

- DigitalOcean droplet `134.199.157.138`, the same box as Tarte Kitchen. Repo at `/root/tarte-inbox`, container `tarte-inbox-inbox-1`, compose service `inbox`, port 8787 inside the Docker network only.
- Public address `https://inbox.tarte.com.au`. TLS, basic auth and routing come from Tarte Kitchen's Caddy (`/root/tarte-kitchen/Caddyfile`, vhost `inbox.tarte.com.au`, `reverse_proxy inbox:8787`).
- Database: Tarte Kitchen's Postgres container (`db:5432`) over the shared Docker network `tarte-kitchen_default`. Tables are prefixed `inbox_`. The schema is applied by `migrate()` on every boot.
- `./attachments` on the droplet is bind mounted to `/app/attachments`. It holds `functions-events-packages.pdf` and `tea-garden-menu.pdf`. Replacing a file there takes effect on the next draft, no deploy needed. Keep a dated `.bak` copy of the old one. Keep the functions pack under 25 MB or Gmail will refuse it.
- The shared network resolves compose service names for every project on it. This service is called `inbox`. Never name a service `app` or `db` here (a second `app` on the network caused an outage on 16 Sep 2026).

## Routine deploy

1. On your machine: `npm run typecheck`, commit, `git push origin main`.
2. If you need recent logs, read them first. The deploy recreates the container and the old logs go with it.
3. Deploy:

```bash
ssh root@134.199.157.138 "cd /root/tarte-inbox && ./scripts/deploy.sh"
```

`deploy.sh` fetches and hard resets to `origin/main`, tags the running image as `tarte-inbox-inbox:prev`, rebuilds, restarts the service and then waits up to about 45 seconds for `/health` inside the container. It exits non zero and prints the rollback command if the new container does not answer.

Documentation only commits do not need a deploy.

## Verify after every deploy

```bash
curl -fsS https://inbox.tarte.com.au/health
ssh root@134.199.157.138 "cd /root/tarte-inbox && git rev-parse --short HEAD && docker compose logs --tail 60 inbox | grep -E 'auto_send|schema applied|tick:'"
```

Expect:

- the pushed commit hash
- `[tarte-inbox] auto_send=false tick=60s`. If `auto_send` is not what you expect, stop and fix it before anything else.
- `[scheduler] tick: seen=N acted=M` within a minute or two. `seen` should be in the hundreds. A small constant number is a cap, not a coincidence.

A restart immediately runs one email tick, one Now Book It ingest with its hourly chain (booking confirmations, calendar sync, spam rescue, coverage sentinel), the unread sweep and the watchdog checks. The digest only sends if today's has not gone out yet.

## Rollback

```bash
ssh root@134.199.157.138 "cd /root/tarte-inbox && docker tag tarte-inbox-inbox:prev tarte-inbox-inbox:latest && docker compose up -d inbox"
```

Then revert the bad commit on `main` and push, so the next deploy does not bring it back. Schema changes are additive, so the previous image runs fine on the newer schema.

## Environment

Secrets live only in `/root/tarte-inbox/.env` on the droplet. Variable names and notes are in `.env.example`.

- `docker-compose.yml` lists every variable explicitly. A variable present in `.env` but missing from the compose `environment:` block never reaches the container. Add new ones to both files.
- After editing `.env`: `docker compose up -d --force-recreate inbox`.
- Switches that matter: `ENABLE_AUTO_SEND` (false in production, Chloe's call only), `ENABLE_BOOKING_CONFIRMATIONS` (default true, the off switch for guest booking confirmation emails), `ENABLE_AUTO_INVOICE` (false, leave it), `TICK_INTERVAL_SECONDS` (60 in production), `ALERT_EMAILS`, `INVOICE_PORTAL_TOKEN`.
- To rotate the portal token, change `INVOICE_PORTAL_TOKEN` and force recreate. Old digest links stop working and the next digest carries the new key.

## Caddy

The vhost lives in the tarte-kitchen repo. Public paths: `/health`, `/oauth/*`, `/invoices`, `/invoice/*`, `/queue`, `/queue/*` (the last four are gated inside the app by the portal token). Everything else needs the shared basic auth login.

The Caddyfile is a bind mount, so after changing it:

```bash
ssh root@134.199.157.138 "cd /root/tarte-kitchen && git pull origin main && docker compose up -d --force-recreate caddy"
```

## Re-authorising Google and Xero

Tokens are stored in `inbox_oauth_tokens` and refreshed automatically. A daily Xero keepalive stops the refresh token dying after 60 idle days. If the watchdog emails that a link is broken, or a new scope has been added in code:

- Google: sign in to a browser as hello@, open `https://inbox.tarte.com.au/oauth/google/start`, accept every scope.
- Xero: open `https://inbox.tarte.com.au/oauth/xero/start`, choose Tarte Currumbin Pty Ltd.

`/status` (basic auth) lists the scopes actually granted. Features that need a scope the grant does not have stay dormant rather than failing (Drive archiving needs `drive.file`).

## Running scripts on the droplet

```bash
ssh root@134.199.157.138
cd /root/tarte-inbox
docker compose exec -T inbox node dist/scripts/<name>.js [args]
```

- The container has no `curl`. Internal endpoints: `docker compose exec -T inbox wget -qO- --post-data= http://localhost:8787/tick`.
- The app user cannot write to `/app`. Use `/tmp` inside the container (`docker cp` works).
- Read the script header first. Many are dry run by default and need `--apply`. Never run `seed-playbooks` on production: it overwrites every playbook. `ingest-sent` without `--dry-run` overwrites the example replies on every playbook.
- The repo is public. Pass customer names and thread ids as arguments. Never commit them.

## When something breaks

- Recent logs: `docker compose logs --tail 200 inbox`
- Soft restart: `docker compose restart inbox`
- Watchdog state: table `inbox_health`. Each failing check emails `ALERT_EMAILS` with the fix.
- No digest by 09:00 Brisbane: check logs for `[daily] error`. To send again, delete today's row in `inbox_digest_log` and `POST /digest/run`.
- "Drafts are not appearing": check `seen=` in the tick log, then `dist/scripts/scan-issues.js` and `dist/scripts/coverage-audit.js` (both read only).
- Build killed on the droplet: the box has about 2 GB of RAM. Check `swapon --show` is not empty and look for leftover build processes. The Dockerfile already caps the TypeScript compiler heap.
- Always compare the droplet HEAD with `origin/main` at the start of a session. Work that is pushed but not deployed protects nobody.

## First-time setup (rebuild only)

1. DNS: A record `inbox.tarte.com.au` to the droplet IP.
2. `git clone https://github.com/chloebwatts-lab/tarte-inbox.git /root/tarte-inbox`
3. `cp .env.example .env` and fill it in. `DATABASE_URL` matches Tarte Kitchen's. Leave `ENABLE_AUTO_SEND=false`.
4. Make sure the `inbox.tarte.com.au` vhost is in Tarte Kitchen's Caddyfile, then force recreate caddy.
5. `mkdir -p attachments`, copy in the functions pack and the Tea Garden menu PDFs, and make the folder readable by the container's `node` user.
6. `./scripts/deploy.sh`
7. Link Google (as hello@) and Xero with the two OAuth URLs above. `/status` should show both linked.
8. On an empty database only: `docker compose exec -T inbox node dist/scripts/seed-playbooks.js`. On an existing database use `seed-missing-playbooks.js`, which never overwrites.
9. Watch `docker compose logs -f inbox` for the first tick, then check labels and drafts in hello@.
