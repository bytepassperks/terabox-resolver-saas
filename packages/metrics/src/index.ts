import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Single process-wide Prometheus registry. All services import this instance
 * (never construct their own) so the `/metrics` endpoint can expose a coherent
 * view regardless of which package produced a given series.
 */
export const registry = new Registry();

collectDefaultMetrics({ register: registry });

const PREFIX = 'trs_';

export const resolveDuration = new Histogram({
  name: `${PREFIX}resolve_duration_ms`,
  help: 'End-to-end resolve latency in milliseconds, labeled by provider and cache status.',
  labelNames: ['provider', 'cache', 'outcome'] as const,
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000, 15000],
  registers: [registry],
});

export const resolveOutcomes = new Counter({
  name: `${PREFIX}resolve_outcomes_total`,
  help: 'Count of resolve attempts by provider and outcome (success / error code).',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

export const cacheHits = new Counter({
  name: `${PREFIX}cache_hits_total`,
  help: 'Metadata cache hits.',
  labelNames: ['layer'] as const,
  registers: [registry],
});

export const cacheMisses = new Counter({
  name: `${PREFIX}cache_misses_total`,
  help: 'Metadata cache misses.',
  labelNames: ['layer'] as const,
  registers: [registry],
});

export const providerErrors = new Counter({
  name: `${PREFIX}provider_errors_total`,
  help: 'Resolver adapter errors, keyed by provider and error code.',
  labelNames: ['provider', 'code'] as const,
  registers: [registry],
});

export const workerLatency = new Histogram({
  name: `${PREFIX}worker_relay_latency_ms`,
  help: 'Round-trip latency through the Cloudflare relay mesh.',
  labelNames: ['relay', 'mode'] as const,
  buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

export const tokenPoolHealth = new Gauge({
  name: `${PREFIX}token_pool_health_score`,
  help: 'Composite health score [0..100] for each bot token, higher is better.',
  labelNames: ['token_id'] as const,
  registers: [registry],
});

export const tokenPoolQueueDepth = new Gauge({
  name: `${PREFIX}token_pool_queue_depth`,
  help: 'Outstanding requests per bot token.',
  labelNames: ['token_id'] as const,
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: `${PREFIX}circuit_breaker_state`,
  help: 'Circuit state per provider: 0 = closed, 0.5 = half-open, 1 = open.',
  labelNames: ['provider'] as const,
  registers: [registry],
});

export const creditsBalanceTotal = new Gauge({
  name: `${PREFIX}credits_balance_total`,
  help: 'Sum of all outstanding user credit balances (sampled).',
  registers: [registry],
});

export const creditsUsageRate = new Counter({
  name: `${PREFIX}credits_consumed_total`,
  help: 'Credits deducted over time.',
  labelNames: ['source'] as const,
  registers: [registry],
});

export const starsWebhookFailures = new Counter({
  name: `${PREFIX}stars_webhook_failures_total`,
  help: 'Telegram Stars webhook failures (duplicate, invalid signature, etc).',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rateLimitRejections = new Counter({
  name: `${PREFIX}rate_limit_rejections_total`,
  help: 'Requests rejected by the rate-limit engine.',
  labelNames: ['scope', 'tier'] as const,
  registers: [registry],
});

export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}
