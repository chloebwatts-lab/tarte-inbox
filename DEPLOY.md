# tarte-inbox deployment runbook

Same droplet as TK (`134.199.157.138`), shares TK's Postgres + Caddy.

## 1. DNS

Add an A record:

| Host | Type | Value |
|---|---|---|
| `inbox.tarte.com.au` | A | `134.199.157.138` |

Wait ~5 min for propagation. Test: `dig +short inbox.tarte.com.au` should return the IP.

## 2. Push the repos

From your laptop:

```bash
cd /Users/chris/C/tarte-inbox
git remote add origin <new-github-repo-url>   # create empty private repo first
git push -u origin main

cd /Users/chris/C/tarte-kitchen
git push origin main   # pushes the Caddyfile change
```

## 3. On the droplet — clone tarte-inbox

```bash
ssh root@134.199.157.138
cd /root
git clone <tarte-inbox-repo-url> tarte-inbox
cd tarte-inbox
```

## 4. On the droplet — fill in `.env`

```bash
cp .env.example .env
nano .env
```

Fill in:

- `DATABASE_URL` — same value as in `/root/tarte-kitchen/.env`. Copy it across.
- `ANTHROPIC_API_KEY` — same as TK's, or a new one.
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` — from local `.env` (already in your laptop's `/Users/chris/C/tarte-inbox/.env`).
- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` — same as above.
- `TEA_GARDEN_CALENDAR_ID`, `BEACH_HOUSE_CALENDAR_ID` — get from Google Calendar settings.
- Leave `ENABLE_AUTO_SEND=false` for launch.

## 5. Update TK's Caddyfile (force-recreate caddy)

Per memory `tarte_deploy.md` — Caddyfile is a bind-mount, so `docker compose up -d caddy` alone won't pick up changes. Need `--force-recreate`:

```bash
cd /root/tarte-kitchen
git pull origin main
docker compose up -d --force-recreate caddy
```

## 6. Build + start tarte-inbox

```bash
cd /root/tarte-inbox
./scripts/deploy.sh
```

This builds the image and starts the container. The first run will apply the DB schema (migration is in-process via `migrate()` on boot).

## 7. Verify

```bash
curl -fsS https://inbox.tarte.com.au/health
# {"ok":true,"ts":"..."}

curl -fsS -u tarte:<basic-auth-pw> https://inbox.tarte.com.au/status
# {"google":{"linked":false,...},"xero":{"linked":false,...},...}
```

## 8. Link Gmail + Xero

In a browser, log into `hello@tarte.com.au`, then visit:

```
https://inbox.tarte.com.au/oauth/google/start
```

Click through the consent screen — grant all scopes.

Then visit (still as hello@, or as whoever owns the Xero org):

```
https://inbox.tarte.com.au/oauth/xero/start
```

Pick the **Tarte Currumbin Pty Ltd** org when prompted.

After both, `/status` should show `linked: true` for both.

## 9. Seed playbooks

```bash
ssh root@134.199.157.138
cd /root/tarte-inbox
docker compose exec inbox node dist/scripts/seed-playbooks.js
```

## 10. Watch the first tick

```bash
docker compose logs -f inbox
```

Wait ~2 min — should see `[scheduler] tick: seen=N acted=M`. Open hello@'s inbox in Gmail and check: labels should be applied, drafts should appear in-thread.

## Subsequent deploys

After pushing new commits:

```bash
ssh root@134.199.157.138 "cd /root/tarte-inbox && ./scripts/deploy.sh"
```

## If something breaks

- `docker compose logs --tail 200 inbox` — recent logs
- `docker compose restart inbox` — soft restart
- `docker compose down && docker compose up -d` — full restart
- DB schema is idempotent (CREATE TABLE IF NOT EXISTS) so restarts are safe
