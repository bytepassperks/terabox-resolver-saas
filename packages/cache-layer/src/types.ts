import type { ProviderId, ResolverResult } from '@trs/shared-types';

/**
 * Config knobs for the two-layer metadata cache. All defaults come from ENV
 * so operators can tune the popularity curve without redeploying code.
 */
export interface CacheConfig {
  baseTtlSeconds: number;
  popularityMultiplierSeconds: number;
  maxTtlSeconds: number;
  /** Redis key used for the resolve-dedup lock (hashed by shareId). */
  lockTtlSeconds: number;
  /** Namespace prefix so multiple environments can share a Redis instance. */
  keyPrefix: string;
}

export interface CacheKey {
  provider: ProviderId;
  shareId: string;
}

export interface CachedEntry {
  result: ResolverResult;
  storedAtMs: number;
  resolveCount: number;
  popularityScore: number;
}
