import { randomUUID } from 'node:crypto';
import {
  MetadataCache,
  getPgPool,
  getRedisClient,
  readCacheConfigFromEnv,
} from '@trs/cache-layer';
import { createLogger } from '@trs/logger';
import {
  AdapterRegistry,
  CircuitBreaker,
  ResolverGateway,
  readResolverCoreConfigFromEnv,
  registerAllProviders,
} from '@trs/resolver-core';

const log = createLogger({ service: 'warm-cache-cron' });

const INTERVAL_MS = Number(process.env.WARM_CACHE_INTERVAL_MS ?? 6 * 3600 * 1000);
const TOP_N = Number(process.env.WARM_CACHE_TOP_N ?? 100);
const CONCURRENCY = Number(process.env.WARM_CACHE_CONCURRENCY ?? 4);

/**
 * Warm-cache cron: every WARM_CACHE_INTERVAL_MS (default 6h), re-resolve the
 * top-N popular share_ids so the hot layer stays warm for trending content.
 *
 * Runs in-process (no external scheduler required) — Render's worker services
 * stay up, and the loop is idempotent so duplicate deploys don't double-work.
 */
async function runOnce(gateway: ResolverGateway, cache: MetadataCache): Promise<void> {
  const targets = await cache.topPopular(TOP_N);
  log.info({ count: targets.length }, 'warm-cache: pass started');

  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < targets.length) {
      const t = targets[idx++]!;
      const reqId = randomUUID();
      try {
        const url = buildRefreshUrl(t.provider, t.shareId);
        if (!url) continue;
        await gateway.resolve({
          url,
          context: {
            requestId: reqId,
            isSystem: true,
            providerOverride: t.provider,
          },
        });
      } catch (err) {
        log.warn({ err, target: t }, 'warm-cache: refresh failed');
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log.info('warm-cache: pass complete');
}

function buildRefreshUrl(provider: string, shareId: string): string | null {
  switch (provider) {
    case 'terabox':
      return `https://www.terabox.com/s/1${shareId}`;
    case 'pixeldrain':
      return `https://pixeldrain.com/u/${shareId}`;
    case 'gofile':
      return `https://gofile.io/d/${shareId}`;
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const redis = getRedisClient();
  const pg = getPgPool();
  const cache = new MetadataCache(redis, pg, readCacheConfigFromEnv(), log);
  const registry = new AdapterRegistry();
  registerAllProviders(registry);
  const cfg = readResolverCoreConfigFromEnv();
  const breaker = new CircuitBreaker({
    redis,
    keyPrefix: cfg.keyPrefix,
    failureThreshold: cfg.failureThreshold,
    retryWindowMs: cfg.retryWindowMs,
  });
  const gateway = new ResolverGateway({ cache, registry, breaker, cfg, log });

  // Run once on startup so fresh deploys warm up immediately.
  await runOnce(gateway, cache).catch((err) => log.error({ err }, 'warm-cache: initial pass failed'));

  setInterval(() => {
    runOnce(gateway, cache).catch((err) => log.error({ err }, 'warm-cache: pass failed'));
  }, INTERVAL_MS).unref();
}

main().catch((err) => {
  log.fatal({ err }, 'warm-cache-cron: failed to start');
  process.exit(1);
});
