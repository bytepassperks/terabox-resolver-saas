# Operations runbook

## Rotating the TeraBox extractor

TeraBox changes its frontend every few weeks. When resolves start failing with
`PROVIDER_AUTH_EXPIRED`:

1. Load a working share link in a browser, open DevTools → Network.
2. Note the request to `/share/list` — copy the `jsToken` from the query string
   and the `dp-logid` cookie.
3. Inspect the sharing page HTML (`view-source:https://www.terabox.com/sharing/link?surl=...`).
   Find where `jsToken` is inlined; adjust `JS_TOKEN_REGEX` in
   `packages/resolver-core/src/providers/terabox/extract.ts`.
4. If `/share/list` or `/share/download` gained new required params (check the
   Network tab), add them to the respective `fetchShareList` / `fetchDownloadLink`
   functions.
5. `pnpm --filter @trs/resolver-core typecheck`, push, deploy.

Everything else in the system — cache, credits, rate limiting, metrics —
survives the rotation untouched.

## Token pool diagnostics

- `GET /admin/tokens` returns the live health list.
- `POST /admin/tokens/quarantine { tokenId }` sidelines a sick token.
- `POST /admin/tokens/release { tokenId }` brings it back.

Prometheus:

```
trs_token_pool_health_score{token_id="bot-2"}  → < 50 indicates degradation
trs_token_pool_queue_depth{token_id="bot-2"}   → spikes imply 429s from Telegram
```

## Cache diagnostics

```
GET  /admin/cache            → { redisKeys }
POST /admin/cache-clear      → nukes Redis cache:* keys (Postgres index kept)
```

Useful when an adapter change invalidates cached payloads.

## Credit reconciliation

Every balance change has a matching row in `credit_mutations`. To audit a user:

```sql
SELECT created_at, delta, source, reason, idempotency_key
  FROM credit_mutations
 WHERE user_id = '<uuid>'
 ORDER BY created_at DESC;
```

## Warm-cache

- Runs in-process inside `trs-warm-cache-cron` every `WARM_CACHE_INTERVAL_MS`.
- `WARM_CACHE_TOP_N` controls batch size (default 100).
- `WARM_CACHE_CONCURRENCY` controls parallelism (default 4).
- Failures are logged but do not halt the pass.

## Common errors

| Error code | Meaning | Action |
| --- | --- | --- |
| `PROVIDER_AUTH_EXPIRED` | jsToken / cookies stale | Follow "Rotating the TeraBox extractor" |
| `PROVIDER_RATE_LIMITED` | Upstream 429 | Wait out `retryWindowMs`; circuit will auto-close |
| `CIRCUIT_OPEN` | Too many recent failures | Investigate logs, then `POST /admin/cache-clear` if needed |
| `CONTENT_PASSWORD_PROTECTED` | Password-protected share | Not supported today; plan addition to `extract.ts` |
| `UNSUPPORTED_URL` | Host not in the detector | Add the host to `url-detector.ts` |
