import { randomUUID } from 'node:crypto';
import type { Logger } from '@trs/logger';
import { MetadataCache } from '@trs/cache-layer';
import { providerErrors, resolveDuration, resolveOutcomes } from '@trs/metrics';
import type { ProviderId, ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from './adapter.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { AdapterRegistry } from './registry.js';
import type { ResolverCoreConfig } from './types.js';
import { detectProvider } from './url-detector.js';

export interface GatewayOptions {
  cache: MetadataCache;
  registry: AdapterRegistry;
  breaker: CircuitBreaker;
  cfg: ResolverCoreConfig;
  log: Logger;
  /** Optional fallback chain per provider. Defaults to `[primary]`. */
  fallbacks?: Partial<Record<ProviderId, ProviderId[]>>;
}

/**
 * Orchestrates the full resolve pipeline. External callers (resolver-api,
 * warm-cache cron) only ever talk to this class; adapters are never invoked
 * directly.
 */
export class ResolverGateway {
  constructor(private readonly opts: GatewayOptions) {}

  async resolve(input: { url: string; context?: Partial<ResolverContext>; password?: string }): Promise<ResolverResult> {
    const ctx: ResolverContext = {
      requestId: input.context?.requestId ?? randomUUID(),
      telegramUserId: input.context?.telegramUserId,
      providerOverride: input.context?.providerOverride,
      isSystem: input.context?.isSystem ?? false,
    };

    const started = Date.now();
    const { url, provider: detected } = detectProvider(input.url);
    const primary = ctx.providerOverride ?? detected;
    const primaryAdapter = this.opts.registry.get(primary);
    const shareId = primaryAdapter.extractShareId(url);
    if (!shareId) {
      throw new ResolverError({
        code: 'INVALID_SHARE_LINK',
        message: 'Could not extract share id from URL',
        provider: primary,
        refundable: true,
        retriable: false,
      });
    }

    // L1/L2 cache lookup before any upstream I/O.
    const cached = await this.opts.cache.get({ provider: primary, shareId });
    if (cached && isFresh(cached.result)) {
      resolveOutcomes.inc({ provider: primary, outcome: 'cache_hit' });
      resolveDuration.observe(
        { provider: primary, cache: 'hit', outcome: 'success' },
        Date.now() - started,
      );
      return { ...cached.result, cached: true };
    }

    // Cache miss → run adapter chain under a cluster-wide singleflight lock
    // so concurrent requests for the same link hit the upstream only once.
    const { result } = await this.opts.cache.singleflightFetch(
      { provider: primary, shareId },
      async () => this.runChain(primary, url, ctx, input.password),
    );
    const stored = await this.opts.cache.put({ provider: result.provider, shareId }, result);
    resolveOutcomes.inc({ provider: result.provider, outcome: 'resolved' });
    resolveDuration.observe(
      { provider: result.provider, cache: 'miss', outcome: 'success' },
      Date.now() - started,
    );
    return { ...stored.result, cached: false };
  }

  private async runChain(primary: ProviderId, url: URL, ctx: ResolverContext, password?: string): Promise<ResolverResult> {
    const chain = [primary, ...(this.opts.fallbacks?.[primary] ?? [])].filter((id) =>
      this.opts.registry.has(id),
    );

    let lastErr: ResolverError | null = null;
    for (const providerId of chain) {
      const adapter = this.opts.registry.get(providerId);
      if (!adapter.capabilities.active && providerId !== primary) continue;

      try {
        await this.opts.breaker.preflight(providerId);
      } catch (err) {
        if (ResolverError.is(err) && err.code === 'CIRCUIT_OPEN') {
          this.opts.log.warn({ providerId, reqId: ctx.requestId }, 'resolver: circuit open, skipping');
          lastErr = err;
          continue;
        }
        throw err;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.cfg.timeoutMs);
      try {
        const result = await adapter.resolve(url, ctx, controller.signal, password);
        await this.opts.breaker.recordSuccess(providerId);
        return result;
      } catch (err) {
        const resolverErr = ResolverError.is(err)
          ? err
          : new ResolverError({
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'unknown adapter error',
              provider: providerId,
              refundable: true,
              retriable: true,
              cause: err,
            });
        providerErrors.inc({ provider: providerId, code: resolverErr.code });
        await this.opts.breaker.recordFailure(providerId);
        this.opts.log.warn(
          { err: resolverErr.toJSON(), providerId, reqId: ctx.requestId },
          'resolver: adapter failed',
        );
        lastErr = resolverErr;
        if (!resolverErr.retriable) throw resolverErr;
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastErr) throw lastErr;
    throw new ResolverError({
      code: 'PROVIDER_DISABLED',
      message: 'No adapter in the fallback chain was able to run',
      provider: primary,
      refundable: true,
      retriable: false,
    });
  }
}

function isFresh(result: ResolverResult): boolean {
  if (!result.expiresAtMs) return true;
  // Add a 30s safety buffer so we don't hand out a URL about to expire.
  return result.expiresAtMs > Date.now() + 30_000;
}
