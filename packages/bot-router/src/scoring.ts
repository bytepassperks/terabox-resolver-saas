import type { BotPoolEntry } from './types.js';

/**
 * Composite health score, tuned so that a single bad signal doesn't immediately
 * sideline a token but a sustained pattern does. Numbers are percentages on
 * [0..100]; selectBestToken picks the max.
 *
 * Weights were picked to match the blueprint's priorities:
 *   - failure rate is the loudest signal (real errors > latency > retries)
 *   - queue depth only discounts heavily-loaded tokens
 *   - latency has a forgiving knee (500ms ≈ 0 penalty, 5s ≈ full penalty)
 */
export function computeHealthScore(entry: Omit<BotPoolEntry, 'healthScore' | 'healthy'>): number {
  const latencyPenalty = Math.min(40, (entry.latencyMs / 5000) * 40);
  const failurePenalty = entry.failureRate * 35;
  const retryPenalty = Math.min(15, entry.retryRate * 15);
  const queuePenalty = Math.min(10, entry.queueDepth * 2);
  const quarantinePenalty = entry.quarantinedAtMs ? 100 : 0;
  const raw = 100 - latencyPenalty - failurePenalty - retryPenalty - queuePenalty - quarantinePenalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Exponentially-weighted moving average helper used by the token pool. */
export function ewma(prev: number, sample: number, alpha = 0.3): number {
  if (!Number.isFinite(prev)) return sample;
  return prev * (1 - alpha) + sample * alpha;
}
