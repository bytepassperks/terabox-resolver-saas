# Architecture

Extended notes — skim [`README.md`](../README.md) first.

## Resolve pipeline (hot path)

```
client (bot or partner HTTP)
        │
        ▼
resolver-api::/v1/resolve
        │
        ├─► rate-limit-engine::checkIp
        │
        ▼
resolver-core::ResolverGateway.resolve
        │
        ├─► url-detector::detectProvider   (host → ProviderId)
        │
        ├─► adapter::extractShareId        (stable primary cache key)
        │
        ├─► cache-layer::MetadataCache.get (L1 Redis → L2 Postgres)
        │     ├─ hit + fresh → return cached result, done
        │     └─ miss / expired
        │
        ├─► cache-layer::singleflightFetch  (Redis NX lock)
        │     ├─ leader: run fallback chain
        │     └─ waiter: poll result key
        │
        ├─► fallback chain (per provider)
        │     ├─ CircuitBreaker.preflight
        │     ├─ adapter.resolve (AbortSignal, timeout)
        │     ├─ CircuitBreaker.recordSuccess / recordFailure
        │     └─ ResolverError.retriable → advance or rethrow
        │
        ├─► cache-layer::put               (write L1 + L2, bump popularity)
        │
        └─► worker-relay-client::wrap      (HMAC-sign stream + download URLs)
```

## Circuit breaker states

```
     on first success
    ┌───────────────────┐
    ▼                   │
  closed ── n failures ──▶ open ── retryWindowMs ──▶ half_open ── 1 probe ──▶ closed | open
```

Breaker state lives in Redis (`trs:circuit:<provider>:state`), so every
replica of `resolver-api` sees the same decision.

## Singleflight

`cache-layer/src/singleflight.ts` implements a cluster-wide lock:

- Leader acquires `SET lockKey value NX EX ttl`.
- Leader writes the final payload to `resultKey` and deletes the lock.
- Waiters poll `resultKey` with exponential backoff up to `waiterTimeoutMs`.
- If the leader dies without publishing, the lock expires and one of the
  waiters promotes itself via a fallback call.

## Popularity TTL

Pure function in `cache-layer/src/popularity-ttl.ts`:

```
ttl_seconds  = clamp(base + resolve_count * multiplier, base, max)
popularity   = round(log2(resolve_count + 1) * 1000)
```

`base`, `multiplier`, `max` are `CACHE_*` env vars. The log-dampened popularity
score is used only to order warm-cache targets.

## Credits

`credit_mutations` is append-only and enforces a `UNIQUE (idempotency_key)`
constraint. Every balance change — including admin adjustments and Stars
settlements — writes a row, so reconciliation is always possible by summing
deltas per user.

`stars_events.telegram_charge_id` is the canonical idempotency key Telegram
provides; we reject duplicates at insert time before touching user balances.

## Multi-bot router

Scoring (see `packages/bot-router/src/scoring.ts`) weights:

| Signal | Weight |
| --- | --- |
| Recent failure rate | 35 |
| Latency (linear up to 5s) | up to 40 |
| Retry-after frequency | up to 15 |
| Queue depth | up to 10 |

Quarantine triggers automatically when the composite score drops below
`TOKEN_POOL_QUARANTINE_THRESHOLD`. Admins can override via the admin API
(`POST /admin/tokens/quarantine`).

## Worker relay modes

### signed-redirect (default)

- Worker verifies HMAC, responds `302` → target URL.
- Cheapest; target server sees the caller's IP.
- Appropriate for long-lived HTTPS endpoints.

### proxy-passthrough

- Worker verifies HMAC, streams upstream body.
- Caller's IP is hidden; worker's region egresses.
- Appropriate when IP diversity is the whole point.

Switch via `RELAY_MODE=signed-redirect | proxy-passthrough` at deploy time.
