import type { RedisClient } from '@trs/cache-layer';
import { rateLimitRejections } from '@trs/metrics';
import type { RateLimitConfig, RateLimitDecision, RateTier } from './types.js';

/**
 * Distributed rate limiter implemented as a pair of fixed-window counters in
 * Redis — one per user (tier-aware window) and one per IP. Fixed windows are
 * intentionally used over sliding windows: they are cheap (a single INCR +
 * EXPIRE) and good enough for anti-abuse on a resolver where we just want to
 * cap burst spam, not precisely throttle RPS.
 */
export class RateLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly cfg: RateLimitConfig,
  ) {}

  private tierWindow(tier: RateTier): number {
    switch (tier) {
      case 'free':
        return this.cfg.freeWindowSeconds;
      case 'paid':
        return this.cfg.paidWindowSeconds;
      case 'premium':
        return this.cfg.premiumWindowSeconds;
    }
  }

  async checkUser(telegramId: number, tier: RateTier): Promise<RateLimitDecision> {
    const window = this.tierWindow(tier);
    const key = `${this.cfg.keyPrefix}rate:user:${telegramId}`;
    const [count] = await this.bumpCounter(key, window);
    if (count > 1) {
      rateLimitRejections.inc({ scope: 'user', tier });
      return { allowed: false, retryAfterSeconds: window, reason: 'user_window' };
    }
    return { allowed: true, retryAfterSeconds: 0, reason: 'ok' };
  }

  async checkIp(ip: string): Promise<RateLimitDecision> {
    const key = `${this.cfg.keyPrefix}rate:ip:${ip}`;
    const [count] = await this.bumpCounter(key, 60);
    if (count > this.cfg.ipPerMinute) {
      rateLimitRejections.inc({ scope: 'ip', tier: 'unknown' });
      return { allowed: false, retryAfterSeconds: 60, reason: 'ip_window' };
    }
    return { allowed: true, retryAfterSeconds: 0, reason: 'ok' };
  }

  private async bumpCounter(key: string, ttl: number): Promise<[number, number]> {
    // Atomic: INCR then EXPIRE only on first hit (NX preserves the original window).
    const pipeline = this.redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, ttl, 'NX');
    const res = await pipeline.exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttlSet = Number(res?.[1]?.[1] ?? 0);
    return [count, ttlSet];
  }
}

export function readRateLimitConfigFromEnv(): RateLimitConfig {
  return {
    freeWindowSeconds: Number(process.env.RATE_LIMIT_FREE_WINDOW_SECONDS ?? 20),
    paidWindowSeconds: Number(process.env.RATE_LIMIT_PAID_WINDOW_SECONDS ?? 5),
    premiumWindowSeconds: Number(process.env.RATE_LIMIT_PREMIUM_WINDOW_SECONDS ?? 2),
    ipPerMinute: Number(process.env.RATE_LIMIT_IP_PER_MINUTE ?? 60),
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'trs:',
  };
}
