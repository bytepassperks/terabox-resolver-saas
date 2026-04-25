import type { CacheConfig } from './types.js';

/**
 * Computes the Redis TTL for a cached metadata entry based on how often it
 * has been resolved. The formula is linear with a hard cap so a single viral
 * link cannot pin arbitrarily-large objects indefinitely.
 *
 *   ttl = clamp(baseTtl + resolveCount * multiplier, baseTtl, maxTtl)
 *
 * Numbers are whole seconds — Redis's EXPIRE does not support sub-second.
 */
export function computePopularityTtlSeconds(resolveCount: number, cfg: CacheConfig): number {
  const safeCount = Math.max(0, Math.floor(resolveCount));
  const raw = cfg.baseTtlSeconds + safeCount * cfg.popularityMultiplierSeconds;
  return Math.max(cfg.baseTtlSeconds, Math.min(cfg.maxTtlSeconds, raw));
}

/**
 * Popularity score is an unbounded counter we expose to operators so warm-cache
 * jobs can pick the top-N items. Using a logarithmic dampener means early hits
 * count more than late ones — prevents one scraper from dominating the curve.
 */
export function computePopularityScore(resolveCount: number): number {
  const n = Math.max(0, resolveCount);
  return Math.round(Math.log2(n + 1) * 1000);
}
