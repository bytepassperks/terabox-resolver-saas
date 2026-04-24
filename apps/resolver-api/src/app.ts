import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '@trs/logger';
import {
  MetadataCache,
  closePgPool,
  closeRedisClient,
  getPgPool,
  getRedisClient,
  readCacheConfigFromEnv,
} from '@trs/cache-layer';
import { renderMetrics } from '@trs/metrics';
import {
  AbuseDetector,
  RateLimiter,
  readRateLimitConfigFromEnv,
} from '@trs/rate-limit-engine';
import {
  AdapterRegistry,
  CircuitBreaker,
  ResolverGateway,
  readResolverCoreConfigFromEnv,
  registerAllProviders,
} from '@trs/resolver-core';
import { ResolverError } from '@trs/shared-types';
import { RelayClient, readRelayConfigFromEnv } from '@trs/worker-relay-client';

const ResolveSchema = z.object({
  url: z.string().url(),
  providerOverride: z.string().optional(),
  telegramUserId: z.number().int().positive().optional(),
  requestId: z.string().min(8).max(64).optional(),
  password: z.string().max(64).optional(),
});

export interface ResolverAppDeps {
  cache: MetadataCache;
  gateway: ResolverGateway;
  relay: RelayClient;
  rateLimiter: RateLimiter;
  abuse: AbuseDetector;
  shutdown: () => Promise<void>;
}

export async function buildDeps(log: Logger): Promise<ResolverAppDeps> {
  const cacheCfg = readCacheConfigFromEnv();
  const resolverCfg = readResolverCoreConfigFromEnv();
  const redis = getRedisClient();
  const pg = getPgPool();
  const cache = new MetadataCache(redis, pg, cacheCfg, log);
  const registry = new AdapterRegistry();
  registerAllProviders(registry);
  const breaker = new CircuitBreaker({
    redis,
    keyPrefix: resolverCfg.keyPrefix,
    failureThreshold: resolverCfg.failureThreshold,
    retryWindowMs: resolverCfg.retryWindowMs,
  });
  const gateway = new ResolverGateway({
    cache,
    registry,
    breaker,
    cfg: resolverCfg,
    log,
    fallbacks: {
      // Example: TeraBox has no live alternate extractor today, but gofile and
      // pixeldrain are unrelated so they don't appear in each other's chain.
      terabox: [],
    },
  });
  const relay = new RelayClient(readRelayConfigFromEnv());
  const rateLimiter = new RateLimiter(redis, readRateLimitConfigFromEnv());
  const abuse = new AbuseDetector(redis, readRateLimitConfigFromEnv().keyPrefix);
  return {
    cache,
    gateway,
    relay,
    rateLimiter,
    abuse,
    shutdown: async () => {
      await closeRedisClient();
      await closePgPool();
    },
  };
}

export async function createResolverApp(log: Logger): Promise<Express> {
  const deps = await buildDeps(log);
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await getRedisClient().ping();
      await getPgPool().query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: err instanceof Error ? err.message : 'unknown' });
    }
  });

  app.get('/metrics', async (_req: Request, res: Response) => {
    const m = await renderMetrics();
    res.setHeader('content-type', m.contentType);
    res.send(m.body);
  });

  app.post('/v1/resolve', async (req: Request, res: Response) => {
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'bad_request', issues: parsed.error.issues });
      return;
    }
    const body = parsed.data;

    // Per-IP throttle is always on; per-user only if the caller passed an ID.
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString();
    const ipDecision = await deps.rateLimiter.checkIp(ip);
    if (!ipDecision.allowed) {
      res.status(429).json({ ok: false, error: 'rate_limited', scope: 'ip', retryAfter: ipDecision.retryAfterSeconds });
      return;
    }

    try {
      const result = await deps.gateway.resolve({
        url: body.url,
        password: body.password,
        context: {
          telegramUserId: body.telegramUserId,
          providerOverride: body.providerOverride as never,
          requestId: body.requestId,
        },
      });
      const rawStreamUrl = result.streamUrl;
      const rawDownloadUrl = result.downloadUrl;
      const streamUrl = result.streamUrl ? deps.relay.wrap(result.streamUrl).url : null;
      const downloadUrl = result.downloadUrl ? deps.relay.wrap(result.downloadUrl).url : null;
      res.json({ ok: true, result: { ...result, streamUrl, downloadUrl, rawStreamUrl, rawDownloadUrl } });
    } catch (err) {
      if (ResolverError.is(err)) {
        res.status(422).json({ ok: false, error: err.toJSON() });
        return;
      }
      log.error({ err }, 'resolver-api: unexpected error');
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // Attach shutdown so the caller can clean up on signal.
  (app as unknown as { deps: ResolverAppDeps }).deps = deps;
  return app;
}
