import type { RedisClient } from '@trs/cache-layer';
import type { AbuseDecision } from './types.js';

/**
 * Heuristic abuse detector running on top of the rate limiter. Looks for
 * signals that a single user is scripting the bot rather than using it
 * interactively:
 *
 *   velocity  — too many resolves per minute
 *   entropy   — share_ids with low lexical entropy (e.g. sequential scanning)
 *   pattern   — identical share_id prefix repeated in rapid succession
 *
 * Output is a composite decision: block, shadow-throttle, or admin-flag.
 * Scores are tunable; defaults intentionally conservative.
 */
export class AbuseDetector {
  constructor(
    private readonly redis: RedisClient,
    private readonly keyPrefix: string,
  ) {}

  async evaluate(telegramId: number, shareId: string): Promise<AbuseDecision> {
    const signals: string[] = [];
    let score = 0;

    const velocityKey = `${this.keyPrefix}abuse:vel:${telegramId}`;
    const vel = await this.redis.incr(velocityKey);
    if (vel === 1) await this.redis.expire(velocityKey, 60);
    if (vel > 30) {
      score += 40;
      signals.push(`velocity:${vel}/min`);
    }

    const entropy = shannonEntropy(shareId);
    if (shareId.length >= 4 && entropy < 2.0) {
      score += 20;
      signals.push(`low_entropy:${entropy.toFixed(2)}`);
    }

    const prefix = shareId.slice(0, Math.max(1, shareId.length - 2));
    const patternKey = `${this.keyPrefix}abuse:pat:${telegramId}:${prefix}`;
    const patCount = await this.redis.incr(patternKey);
    if (patCount === 1) await this.redis.expire(patternKey, 300);
    if (patCount > 5) {
      score += 30;
      signals.push(`pattern_scan:${patCount}`);
    }

    return {
      block: score >= 70,
      shadowThrottle: score >= 40 && score < 70,
      adminFlag: score >= 60,
      score,
      signals,
    };
  }
}

/**
 * Classic Shannon entropy over characters — tiny helper that lets us detect
 * "aaaa0001 / aaaa0002 / …" enumeration by scrapers.
 */
export function shannonEntropy(input: string): number {
  if (!input) return 0;
  const counts = new Map<string, number>();
  for (const ch of input) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const len = input.length;
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
