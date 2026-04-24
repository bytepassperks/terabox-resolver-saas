import type { RedisClient } from '@trs/cache-layer';
import type { Logger } from '@trs/logger';
import { tokenPoolHealth, tokenPoolQueueDepth } from '@trs/metrics';
import type { BotPoolEntry } from '@trs/shared-types';
import { computeHealthScore, ewma } from './scoring.js';
import type { TokenPoolConfig, TokenStatsDelta } from './types.js';

interface TokenSeed {
  id: string;
  token: string;
}

/**
 * Manages a pool of Telegram bot tokens distributed across multiple replicas.
 * Live stats (latency, failure rate, retry rate, queue depth) are kept in
 * Redis so every resolver-api / bot replica sees the same health picture.
 *
 * Token values themselves stay in-process only — Redis holds a masked "tail"
 * for observability. `select()` returns the healthiest eligible token id
 * (least-busy + highest score) and an opaque token accessor.
 */
export class TokenPool {
  private readonly byId = new Map<string, TokenSeed>();

  constructor(
    tokens: TokenSeed[],
    private readonly redis: RedisClient,
    private readonly cfg: TokenPoolConfig,
    private readonly log: Logger,
  ) {
    for (const t of tokens) this.byId.set(t.id, t);
  }

  static fromEnv(raw: string | undefined): TokenSeed[] {
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((token, i) => ({ id: `bot-${i + 1}`, token }));
  }

  async list(): Promise<BotPoolEntry[]> {
    const entries = await Promise.all(
      Array.from(this.byId.keys()).map((id) => this.read(id)),
    );
    return entries;
  }

  /** Selects the healthiest token; returns null if the pool is fully sidelined. */
  async select(): Promise<{ entry: BotPoolEntry; token: string } | null> {
    const entries = await this.list();
    const eligible = entries.filter((e) => e.healthy);
    if (eligible.length === 0) {
      this.log.warn('bot-router: no healthy tokens available');
      return null;
    }
    eligible.sort((a, b) => b.healthScore - a.healthScore || a.queueDepth - b.queueDepth);
    const best = eligible[0]!;
    const seed = this.byId.get(best.id);
    if (!seed) return null;
    return { entry: best, token: seed.token };
  }

  /** Merges live metrics into the per-token stats hash and refreshes score. */
  async record(delta: TokenStatsDelta): Promise<void> {
    const key = this.statsKey(delta.tokenId);
    const existing = await this.read(delta.tokenId);
    const next: Omit<BotPoolEntry, 'healthScore' | 'healthy'> = {
      id: existing.id,
      tokenTail: existing.tokenTail,
      latencyMs: delta.latencyMs != null ? ewma(existing.latencyMs, delta.latencyMs) : existing.latencyMs,
      failureRate:
        delta.failed != null ? ewma(existing.failureRate, delta.failed ? 1 : 0) : existing.failureRate,
      retryRate:
        delta.retryAfterMs != null ? ewma(existing.retryRate, delta.retryAfterMs > 0 ? 1 : 0) : existing.retryRate,
      queueDepth: Math.max(0, existing.queueDepth + (delta.queueDelta ?? 0)),
      quarantinedAtMs: existing.quarantinedAtMs,
    };
    const healthScore = computeHealthScore(next);
    if (healthScore < this.cfg.quarantineThreshold && !next.quarantinedAtMs) {
      next.quarantinedAtMs = Date.now();
      this.log.warn({ tokenId: delta.tokenId, healthScore }, 'bot-router: token quarantined');
    } else if (next.quarantinedAtMs && Date.now() - next.quarantinedAtMs >= this.cfg.quarantineCooldownSeconds * 1000) {
      next.quarantinedAtMs = null;
      this.log.info({ tokenId: delta.tokenId }, 'bot-router: token returning to service');
    }

    tokenPoolHealth.set({ token_id: delta.tokenId }, healthScore);
    tokenPoolQueueDepth.set({ token_id: delta.tokenId }, next.queueDepth);

    await this.redis.hset(key, {
      latencyMs: String(next.latencyMs),
      failureRate: String(next.failureRate),
      retryRate: String(next.retryRate),
      queueDepth: String(next.queueDepth),
      quarantinedAtMs: next.quarantinedAtMs ? String(next.quarantinedAtMs) : '',
    });
    await this.redis.expire(key, 3600);
  }

  /** Reads current stats for a token (defaults if unseen). */
  private async read(id: string): Promise<BotPoolEntry> {
    const seed = this.byId.get(id);
    if (!seed) throw new Error(`Unknown token id: ${id}`);
    const h = await this.redis.hgetall(this.statsKey(id));
    const quarantinedAtMs = h['quarantinedAtMs'] ? Number(h['quarantinedAtMs']) : null;
    const base = {
      id,
      tokenTail: `…${seed.token.slice(-4)}`,
      latencyMs: Number(h['latencyMs'] ?? 0),
      failureRate: Number(h['failureRate'] ?? 0),
      retryRate: Number(h['retryRate'] ?? 0),
      queueDepth: Number(h['queueDepth'] ?? 0),
      quarantinedAtMs,
    };
    const healthScore = computeHealthScore(base);
    return { ...base, healthScore, healthy: !quarantinedAtMs && healthScore >= this.cfg.quarantineThreshold };
  }

  private statsKey(id: string): string {
    return `${this.cfg.keyPrefix}router:token:${id}`;
  }

  /** Admin-only: force a token out of rotation until manually cleared. */
  async quarantine(id: string): Promise<void> {
    const key = this.statsKey(id);
    await this.redis.hset(key, { quarantinedAtMs: String(Date.now()) });
  }

  async release(id: string): Promise<void> {
    const key = this.statsKey(id);
    await this.redis.hset(key, { quarantinedAtMs: '' });
  }
}

export function readTokenPoolConfigFromEnv(): TokenPoolConfig {
  return {
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'trs:',
    quarantineThreshold: Number(process.env.TOKEN_POOL_QUARANTINE_THRESHOLD ?? 25),
    quarantineCooldownSeconds: Number(process.env.TOKEN_POOL_QUARANTINE_COOLDOWN_SECONDS ?? 300),
    statsWindowSeconds: Number(process.env.TOKEN_POOL_STATS_WINDOW_SECONDS ?? 300),
  };
}
