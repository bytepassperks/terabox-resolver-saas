# Deployment (Render)

## 0. Prereqs

- Render account.
- Telegram bots (1 public + 2-4 worker tokens).
- Cloudflare account (for relay mesh; optional at launch).

## 1. Push to a GitHub repo Render can read

```bash
git remote add origin git@github.com:<you>/terabox-resolver-saas.git
git push -u origin main
```

## 2. Apply the blueprint

From Render's dashboard: **Blueprints → New Blueprint → connect repo →
`infra/render/render.yaml`**. This provisions:

- `trs-postgres` (managed Postgres 16)
- `trs-redis` (managed Redis)
- `trs-resolver-api` (web service)
- `trs-telegram-bot` (web service)
- `trs-admin-api` (web service)
- `trs-warm-cache-cron` (worker service)

`envVarGroups.trs-shared-env` holds every config knob — defaults are copied
from `.env.example`. Secrets are marked `sync: false`; fill them in through
the Render secret UI.

## 3. Apply SQL migrations (once)

Use Render's **Shell** tab on `trs-resolver-api` (or any Postgres-adjacent
service) and run:

```bash
psql "$DATABASE_URL" -f infra/sql/0001_init.sql
```

## 4. Configure the Telegram webhook

The bot auto-registers its webhook when `TELEGRAM_WEBHOOK_URL` is set. Use
the public URL of the `trs-telegram-bot` service (e.g.
`https://trs-telegram-bot.onrender.com`). Set
`TELEGRAM_WEBHOOK_SECRET` to a long random string so Telegram's requests are
authenticated.

## 5. Deploy the relay worker mesh (Cloudflare)

For each region (e.g. `apac`, `eu`, `us`):

```bash
cd infra/workers/relay
cp wrangler.toml wrangler.apac.toml   # one per region
# Edit `name = "trs-relay-apac"` etc.
pnpm wrangler deploy --config wrangler.apac.toml
pnpm wrangler secret put WORKER_RELAY_SECRET --config wrangler.apac.toml
```

Then update `WORKER_RELAY_URLS` in Render's env group with the comma-separated
list of deployed worker URLs.

## 6. Verify

```bash
curl https://trs-resolver-api.onrender.com/health
curl https://trs-resolver-api.onrender.com/ready
curl https://trs-resolver-api.onrender.com/metrics | head
```

- Hit the bot with `/start`; confirm credits appear.
- Try a supported share link; look for a cached-vs-fresh second request.
- Inspect `/metrics` for `trs_resolve_duration_ms` histograms.

## 7. Scale out

- Increase `TELEGRAM_BOT_TOKENS` count for higher Telegram RPS headroom.
- Add more `trs-resolver-api` replicas (Render's "num instances" setting).
- Add more relay worker regions; `resolver-api` will round-robin them.
- Warm-cache cron can run as a single replica — duplicates are idempotent.
