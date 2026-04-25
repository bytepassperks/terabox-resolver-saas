# terabox-resolver-saas

Production-grade multi-provider share-link resolver SaaS, wrapped in a Telegram bot.
Built as a modular monorepo so each piece (bot, resolver gateway, admin API,
worker relay, warm-cache cron) scales and deploys independently.

> ⚠️ **Operator note:** TeraBox's terms of service prohibit programmatic access to
> share links. This repo is shipped as an engineering blueprint — running it
> against TeraBox in production is a legal/ethical decision you must make for
> yourself. The TeraBox extractor **will** need maintenance whenever TeraBox
> rotates its frontend (typically every few weeks). The codebase is designed
> around that reality: the extractor lives in one file
> (`packages/resolver-core/src/providers/terabox/extract.ts`) and every other
> piece of the system is provider-agnostic.

---

## Architecture

```
 Telegram Stars
       │
       ▼
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  telegram-bot    │ ────▶ │  resolver-api    │ ────▶ │  Cloudflare      │
│  (grammY,        │  JSON │  (Express,       │  HMAC │  relay worker    │
│   multi-token    │       │   fallback chain,│       │  mesh            │
│   router)        │       │   circuit breaker)│      │  (signed-redirect│
└──────────────────┘       └──────────────────┘       │   or passthrough)│
       │                     │        │               └──────────────────┘
       │                     ▼        ▼
       │              ┌─────────┐ ┌─────────┐
       │              │  Redis  │ │Postgres │
       │              │(L1 +    │ │(L2 +    │
       │              │ locks + │ │ credits │
       │              │ rates)  │ │ audits) │
       │              └─────────┘ └─────────┘
       ▼                              ▲
┌──────────────────┐                  │
│  admin-api       │ ─────────────────┘
│  (JWT, roles)    │
└──────────────────┘
       ▲
       │
┌──────────────────┐
│ warm-cache-cron  │ re-resolves top-100 popular share_ids every 6h
└──────────────────┘
```

## Monorepo layout

```
apps/
  telegram-bot/        grammY bot, Stars invoices, rate limiting, admin cmds
  resolver-api/        Express gateway: /v1/resolve, /health, /ready, /metrics
  admin-api/           JWT-auth'd admin endpoints (roles: support/admin/super_admin)
  warm-cache-cron/     In-process scheduler for top-N refresh

packages/
  shared-types/        Canonical ResolverResult, errors, admin roles, telegram types
  logger/              pino wrapper with redaction list
  metrics/             Prometheus registry + standard series (cache/provider/token)
  cache-layer/         Two-layer cache (Redis L1 + Postgres L2), singleflight lock,
                       popularity-aware TTL
  rate-limit-engine/   Per-user / per-IP fixed windows + abuse heuristics
                       (velocity, entropy, pattern)
  credits-engine/      Tx-safe deduction, credit_mutations audit, Stars idempotency
  bot-router/          Telegram token pool with latency+failure+retry+queue scoring
  worker-relay-client/ HMAC URL builder, signed-redirect / proxy-passthrough modes
  resolver-core/       Adapter interface, registry, fallback chain, circuit breaker
    providers/terabox/   extract.ts / normalize.ts / refresh.ts / types.ts / adapter.ts
    providers/pixeldrain/
    providers/gofile/           (scaffolded)
    providers/buzzheavier/      (scaffolded)
    providers/placeholders.ts   (drive, dropbox, onedrive, mediafire — ready)

infra/
  sql/                 Plain .sql migrations, idempotent
  docker/              One Dockerfile per service + docker-compose for local
  render/              render.yaml blueprint (Postgres + Redis + 4 services)
  workers/relay/       Cloudflare Worker template (HMAC verify → redirect/proxy)

docs/                  Deployment + operations runbooks
.github/workflows/     CI: pnpm build + typecheck + docker build
```

## Quickstart (local)

```bash
# 1. install
pnpm install

# 2. bring up Postgres + Redis + all services
cp .env.example .env   # fill in TELEGRAM_BOT_TOKENS at minimum
docker compose -f infra/docker/docker-compose.yml up --build

# 3. apply migrations (first run only)
psql "$DATABASE_URL" -f infra/sql/0001_init.sql

# 4. talk to your bot on Telegram → /start
```

## Running pieces separately (dev loop)

```bash
pnpm --filter @trs/resolver-api  dev
pnpm --filter @trs/telegram-bot  dev
pnpm --filter @trs/admin-api     dev
pnpm --filter @trs/warm-cache-cron dev
```

## Deploying

- **Render** — see [`infra/render/render.yaml`](./infra/render/render.yaml) and
  [`docs/deployment.md`](./docs/deployment.md).
- **Cloudflare relay mesh** — `cd infra/workers/relay && pnpm wrangler deploy`
  (one per region).
- **Telegram Stars** — no provider token required, the bot sends invoices in
  the `XTR` currency. See [`docs/stars.md`](./docs/stars.md).

## Observability

Every service exposes `GET /metrics` (Prometheus text format). Standard series:

| Series | Description |
| --- | --- |
| `trs_resolve_duration_ms` | End-to-end resolve latency (labeled by provider, cache, outcome) |
| `trs_resolve_outcomes_total` | Resolve counts per provider/outcome |
| `trs_cache_hits_total` / `trs_cache_misses_total` | Cache layer stats (Redis / Postgres) |
| `trs_provider_errors_total` | Adapter error counts by code |
| `trs_circuit_breaker_state` | Per-provider breaker: 0 closed, 0.5 half-open, 1 open |
| `trs_worker_relay_latency_ms` | Relay round-trip latency by region + mode |
| `trs_token_pool_health_score` | 0-100 health score per Telegram token |
| `trs_token_pool_queue_depth` | Outstanding request count per token |
| `trs_credits_consumed_total` | Credit usage by source |
| `trs_stars_webhook_failures_total` | Stars settlement failures by reason |
| `trs_rate_limit_rejections_total` | Rate-limit rejections by scope/tier |

## Safety rails

- **Copyright-safe delivery** — the bot never uploads files. It returns
  stream + download URLs (optionally wrapped through the Cloudflare relay).
- **No file hosting** — the system stores only metadata in Postgres.
- **Credit refund** — if the resolver fails after a credit deduction, the
  caller can (and should) refund the idempotency key via
  `CreditsService.refund`.
- **Idempotent Stars webhook** — duplicate deliveries are rejected at insert
  time via `stars_events.telegram_charge_id`.

## License

No license granted. This is a private reference implementation; add one before
publishing.
