import type { RedisClient } from './redis-client.js';

/**
 * Cluster-safe single-flight: ensures only one resolver runs per shareId even
 * across multiple resolver-api replicas. Waiters poll the result key with
 * short sleeps rather than pub/sub to keep the Redis footprint minimal.
 *
 * Returns a function callers invoke with their work. If another process won
 * the lock, the waiter reads the published result; if the leader fails, all
 * waiters observe the TTL expiring and can retry on their own.
 */
export interface SingleflightOptions {
  redis: RedisClient;
  /** Fully-qualified Redis key, including prefix. */
  lockKey: string;
  /** Fully-qualified Redis key where the leader publishes its JSON result. */
  resultKey: string;
  lockTtlSeconds: number;
  /** Max total wait for waiters in ms. Should be <= lockTtlSeconds * 1000. */
  waiterTimeoutMs: number;
}

export async function singleflight<T>(
  opts: SingleflightOptions,
  compute: () => Promise<T>,
): Promise<{ value: T; leader: boolean }> {
  const token = Math.random().toString(36).slice(2);
  const acquired = await opts.redis.set(
    opts.lockKey,
    token,
    'EX',
    opts.lockTtlSeconds,
    'NX',
  );

  if (acquired === 'OK') {
    try {
      const value = await compute();
      // Publish result so waiters can short-circuit without re-running.
      await opts.redis.set(
        opts.resultKey,
        JSON.stringify(value),
        'EX',
        Math.max(5, opts.lockTtlSeconds),
      );
      return { value, leader: true };
    } finally {
      // Release lock iff we still hold it (avoid deleting someone else's).
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end`;
      await opts.redis.eval(script, 1, opts.lockKey, token);
    }
  }

  // Waiter path — poll the result key with exponential backoff.
  const start = Date.now();
  let delay = 50;
  while (Date.now() - start < opts.waiterTimeoutMs) {
    const published = await opts.redis.get(opts.resultKey);
    if (published) {
      return { value: JSON.parse(published) as T, leader: false };
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(500, Math.round(delay * 1.5));
  }
  // Leader never published — fall back to running it ourselves.
  const value = await compute();
  return { value, leader: false };
}
