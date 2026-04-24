import type { RedisClient } from '@trs/cache-layer';
import { circuitBreakerState } from '@trs/metrics';
import type { ProviderId } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';

export interface CircuitBreakerOptions {
  redis: RedisClient;
  keyPrefix: string;
  failureThreshold: number;
  retryWindowMs: number;
}

type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Redis-backed circuit breaker shared across all resolver-api replicas.
 *
 *   closed    — errors are counted in a sliding window
 *   open      — all requests short-circuit until `retryWindowMs` passes
 *   half_open — one probe is allowed; success closes, failure reopens
 */
export class CircuitBreaker {
  constructor(private readonly opts: CircuitBreakerOptions) {}

  private stateKey(provider: ProviderId): string {
    return `${this.opts.keyPrefix}circuit:${provider}:state`;
  }

  private failuresKey(provider: ProviderId): string {
    return `${this.opts.keyPrefix}circuit:${provider}:failures`;
  }

  async preflight(provider: ProviderId): Promise<void> {
    const state = (await this.opts.redis.get(this.stateKey(provider))) as BreakerState | null;
    circuitBreakerState.set({ provider }, state === 'open' ? 1 : state === 'half_open' ? 0.5 : 0);
    if (state === 'open') {
      throw new ResolverError({
        code: 'CIRCUIT_OPEN',
        message: `Circuit open for ${provider}`,
        provider,
        refundable: true,
        retriable: true,
      });
    }
  }

  async recordSuccess(provider: ProviderId): Promise<void> {
    await this.opts.redis.del(this.failuresKey(provider));
    await this.opts.redis.del(this.stateKey(provider));
    circuitBreakerState.set({ provider }, 0);
  }

  async recordFailure(provider: ProviderId): Promise<void> {
    const failuresKey = this.failuresKey(provider);
    const count = await this.opts.redis.incr(failuresKey);
    if (count === 1) {
      await this.opts.redis.pexpire(failuresKey, this.opts.retryWindowMs);
    }
    if (count >= this.opts.failureThreshold) {
      await this.opts.redis.set(
        this.stateKey(provider),
        'open',
        'PX',
        this.opts.retryWindowMs,
      );
      circuitBreakerState.set({ provider }, 1);
    }
  }
}
