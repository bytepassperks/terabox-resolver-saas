import type { Logger } from '@trs/logger';
import { cacheHits, cacheMisses } from '@trs/metrics';
import type { ProviderId, ResolverResult } from '@trs/shared-types';
import type { RedisClient } from './redis-client.js';
import type { Pool } from 'pg';
import { computePopularityScore, computePopularityTtlSeconds } from './popularity-ttl.js';
import { singleflight } from './singleflight.js';
import type { CacheConfig, CacheKey, CachedEntry } from './types.js';

/**
 * Two-layer cache:
 *
 *   L1 (Redis)     — millisecond reads, TTL'd by popularity-aware formula.
 *   L2 (Postgres)  — durable metadata index; survives Redis flushes and is
 *                    used by warm-cache cron jobs and analytics.
 *
 * All cache writes go to both layers. Reads prefer L1 and populate it from
 * L2 on miss (when L2 has a still-valid entry). This keeps the hot path fast
 * while still giving operators a persistent audit trail of what's been
 * resolved.
 */
export class MetadataCache {
  constructor(
    private readonly redis: RedisClient,
    private readonly pg: Pool,
    private readonly cfg: CacheConfig,
    private readonly log: Logger,
  ) {}

  private k(key: CacheKey, kind: 'meta' | 'lock' | 'result'): string {
    return `${this.cfg.keyPrefix}cache:${kind}:${key.provider}:${key.shareId}`;
  }

  /** L1 read; falls through to L2 if the hot layer is cold. */
  async get(key: CacheKey): Promise<CachedEntry | null> {
    const raw = await this.redis.get(this.k(key, 'meta'));
    if (raw) {
      cacheHits.inc({ layer: 'redis' });
      try {
        return JSON.parse(raw) as CachedEntry;
      } catch (err) {
        this.log.warn({ err, key }, 'cache_layer: corrupt L1 entry, evicting');
        await this.redis.del(this.k(key, 'meta'));
      }
    }
    cacheMisses.inc({ layer: 'redis' });

    // L2 fallback
    const row = await this.pg.query<{
      payload: ResolverResult;
      resolve_count: number;
      popularity_score: number;
      last_checked: Date;
    }>(
      `SELECT payload, resolve_count, popularity_score, last_checked
         FROM metadata_index
        WHERE provider = $1 AND share_id = $2
        LIMIT 1`,
      [key.provider, key.shareId],
    );
    if (row.rowCount === 0 || !row.rows[0]) {
      cacheMisses.inc({ layer: 'postgres' });
      return null;
    }
    cacheHits.inc({ layer: 'postgres' });
    const r = row.rows[0];
    const entry: CachedEntry = {
      result: r.payload,
      storedAtMs: new Date(r.last_checked).getTime(),
      resolveCount: r.resolve_count,
      popularityScore: r.popularity_score,
    };

    // Rehydrate L1 if the payload is still unexpired.
    if (isUnexpired(entry.result)) {
      const ttl = computePopularityTtlSeconds(entry.resolveCount, this.cfg);
      await this.redis.set(this.k(key, 'meta'), JSON.stringify(entry), 'EX', ttl);
    }
    return entry;
  }

  /** Writes to both L1 and L2. Bumps the resolve counter and popularity score. */
  async put(key: CacheKey, result: ResolverResult): Promise<CachedEntry> {
    const now = Date.now();

    // Upsert L2 first so the durable counter drives L1's TTL decision.
    const upserted = await this.pg.query<{ resolve_count: number; popularity_score: number }>(
      `INSERT INTO metadata_index
         (provider, share_id, payload, resolve_count, popularity_score, last_checked)
       VALUES ($1, $2, $3, 1, $4, NOW())
       ON CONFLICT (provider, share_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             resolve_count = metadata_index.resolve_count + 1,
             popularity_score = $4,
             last_checked = NOW()
       RETURNING resolve_count, popularity_score`,
      [key.provider, key.shareId, result, 0],
    );

    const resolveCount = upserted.rows[0]?.resolve_count ?? 1;
    const popularityScore = computePopularityScore(resolveCount);

    // Second write fixes the popularity_score with the log-dampened value.
    if (popularityScore !== upserted.rows[0]?.popularity_score) {
      await this.pg.query(
        `UPDATE metadata_index SET popularity_score = $1 WHERE provider = $2 AND share_id = $3`,
        [popularityScore, key.provider, key.shareId],
      );
    }

    const entry: CachedEntry = {
      result,
      storedAtMs: now,
      resolveCount,
      popularityScore,
    };
    const ttl = computePopularityTtlSeconds(resolveCount, this.cfg);
    await this.redis.set(this.k(key, 'meta'), JSON.stringify(entry), 'EX', ttl);
    return entry;
  }

  async invalidate(key: CacheKey): Promise<void> {
    await this.redis.del(this.k(key, 'meta'));
    await this.pg.query(
      `DELETE FROM metadata_index WHERE provider = $1 AND share_id = $2`,
      [key.provider, key.shareId],
    );
  }

  /** Returns the top-N most popular shareIds for warm-cache refresh cron. */
  async topPopular(limit: number): Promise<Array<{ provider: ProviderId; shareId: string }>> {
    const rows = await this.pg.query<{ provider: ProviderId; share_id: string }>(
      `SELECT provider, share_id
         FROM metadata_index
        ORDER BY popularity_score DESC, last_checked DESC
        LIMIT $1`,
      [limit],
    );
    return rows.rows.map((r) => ({ provider: r.provider, shareId: r.share_id }));
  }

  /**
   * Runs `fetch` guarded by a cluster-wide lock so N concurrent requests for
   * the same shareId collapse into one upstream call. Cache miss path only.
   */
  async singleflightFetch(
    key: CacheKey,
    fetch: () => Promise<ResolverResult>,
  ): Promise<{ result: ResolverResult; leader: boolean }> {
    const { value, leader } = await singleflight<ResolverResult>(
      {
        redis: this.redis,
        lockKey: this.k(key, 'lock'),
        resultKey: this.k(key, 'result'),
        lockTtlSeconds: this.cfg.lockTtlSeconds,
        waiterTimeoutMs: this.cfg.lockTtlSeconds * 1000,
      },
      fetch,
    );
    return { result: value, leader };
  }
}

function isUnexpired(result: ResolverResult): boolean {
  if (!result.expiresAtMs) return true;
  return result.expiresAtMs > Date.now() + 15_000;
}

export function readCacheConfigFromEnv(): CacheConfig {
  return {
    baseTtlSeconds: Number(process.env.CACHE_BASE_TTL_SECONDS ?? 7200),
    popularityMultiplierSeconds: Number(process.env.CACHE_POPULARITY_MULTIPLIER_SECONDS ?? 600),
    maxTtlSeconds: Number(process.env.CACHE_MAX_TTL_SECONDS ?? 86400),
    lockTtlSeconds: Number(process.env.RESOLVE_LOCK_TTL_SECONDS ?? 30),
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'trs:',
  };
}
