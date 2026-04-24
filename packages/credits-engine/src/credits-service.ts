import type { Logger } from '@trs/logger';
import { creditsUsageRate } from '@trs/metrics';
import type {
  CreditMutation,
  CreditMutationSource,
  PlanId,
  UserBalance,
} from '@trs/shared-types';
import type { Pool, PoolClient } from 'pg';
import { getPlan } from './plans.js';

export interface CreditsServiceOptions {
  pg: Pool;
  log: Logger;
  /** Cost in credits for a successful resolve. */
  resolveCost: number;
  /** Daily free credit grant amount. */
  freeDailyCredits: number;
}

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly userId: string,
    public readonly required: number,
    public readonly available: number,
  ) {
    super(`Insufficient credits: required ${required}, available ${available}`);
    this.name = 'InsufficientCreditsError';
  }
}

export class UserBlockedError extends Error {
  constructor(public readonly userId: string) {
    super(`User ${userId} is blocked`);
    this.name = 'UserBlockedError';
  }
}

/**
 * Transaction-safe credits engine. Every balance mutation is recorded in
 * `credit_mutations` keyed by idempotency_key, so Telegram webhook retries,
 * resolver retry loops, and admin retries never double-apply.
 *
 * The "charge then refund on failure" flow is expressed as two atomic
 * operations, each idempotent in its own right. If the refund never arrives
 * (worst case: resolver-api crashes after charge commits), a reconciliation
 * job can replay using the `resolve_logs.status != 'success'` + matching
 * idempotency key as source of truth.
 */
export class CreditsService {
  constructor(private readonly opts: CreditsServiceOptions) {}

  async ensureUser(telegramId: number, defaults?: { plan?: PlanId }): Promise<UserBalance> {
    const plan = defaults?.plan ?? 'free';
    const rows = await this.opts.pg.query<UserRow>(
      `INSERT INTO users (telegram_id, credits, plan)
         VALUES ($1, $2, $3)
         ON CONFLICT (telegram_id) DO UPDATE SET last_active_at = NOW()
         RETURNING *`,
      [telegramId, this.opts.freeDailyCredits, plan],
    );
    return this.row2balance(rows.rows[0]!);
  }

  async getBalance(telegramId: number): Promise<UserBalance | null> {
    const rows = await this.opts.pg.query<UserRow>(
      `SELECT * FROM users WHERE telegram_id = $1 LIMIT 1`,
      [telegramId],
    );
    if (rows.rowCount === 0) return null;
    return this.row2balance(rows.rows[0]!);
  }

  /** Deducts credits atomically; throws when user is blocked or underfunded. */
  async charge(input: {
    userId: string;
    idempotencyKey: string;
    amount?: number;
    source: CreditMutationSource;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<UserBalance> {
    const amount = input.amount ?? this.opts.resolveCost;
    return this.tx(async (client) => {
      const dup = await this.findMutation(client, input.idempotencyKey);
      if (dup) {
        this.opts.log.debug({ idempotencyKey: input.idempotencyKey }, 'credits: duplicate charge, skipping');
        return this.getUserForUpdate(client, input.userId);
      }

      const user = await this.getUserForUpdate(client, input.userId);
      if (user.isBlocked) throw new UserBlockedError(input.userId);
      if (user.credits < amount) {
        throw new InsufficientCreditsError(input.userId, amount, user.credits);
      }

      await client.query(`UPDATE users SET credits = credits - $1, lifetime_credits_used = lifetime_credits_used + $1 WHERE id = $2`,
        [amount, input.userId],
      );
      await this.recordMutation(client, {
        userId: input.userId,
        delta: -amount,
        source: input.source,
        reason: input.reason ?? null,
        adminId: null,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? null,
      });
      creditsUsageRate.inc({ source: input.source }, amount);
      return this.getUserForUpdate(client, input.userId);
    });
  }

  async refund(input: {
    userId: string;
    idempotencyKey: string;
    amount?: number;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<UserBalance> {
    const amount = input.amount ?? this.opts.resolveCost;
    return this.tx(async (client) => {
      const dup = await this.findMutation(client, input.idempotencyKey);
      if (dup) return this.getUserForUpdate(client, input.userId);
      await client.query(
        `UPDATE users SET credits = credits + $1, lifetime_credits_used = GREATEST(0, lifetime_credits_used - $1) WHERE id = $2`,
        [amount, input.userId],
      );
      await this.recordMutation(client, {
        userId: input.userId,
        delta: amount,
        source: 'resolve_refund',
        reason: input.reason ?? 'resolver failed after deduction',
        adminId: null,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? null,
      });
      return this.getUserForUpdate(client, input.userId);
    });
  }

  async grant(input: {
    userId: string;
    idempotencyKey: string;
    amount: number;
    source: CreditMutationSource;
    reason?: string;
    adminId?: string;
    plan?: PlanId;
    metadata?: Record<string, unknown>;
  }): Promise<UserBalance> {
    return this.tx(async (client) => {
      const dup = await this.findMutation(client, input.idempotencyKey);
      if (dup) return this.getUserForUpdate(client, input.userId);
      if (input.plan) {
        const plan = getPlan(input.plan);
        const expiresAt = plan.validityDays
          ? new Date(Date.now() + plan.validityDays * 86400_000)
          : null;
        await client.query(
          `UPDATE users SET credits = credits + $1, plan = $2, plan_expires_at = $3 WHERE id = $4`,
          [input.amount, input.plan, expiresAt, input.userId],
        );
      } else {
        await client.query(`UPDATE users SET credits = credits + $1 WHERE id = $2`, [
          input.amount,
          input.userId,
        ]);
      }
      await this.recordMutation(client, {
        userId: input.userId,
        delta: input.amount,
        source: input.source,
        reason: input.reason ?? null,
        adminId: input.adminId ?? null,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? null,
      });
      return this.getUserForUpdate(client, input.userId);
    });
  }

  async setBlocked(userId: string, blocked: boolean, adminId: string, reason?: string): Promise<void> {
    await this.opts.pg.query(`UPDATE users SET is_blocked = $1 WHERE id = $2`, [blocked, userId]);
    await this.opts.pg.query(
      `INSERT INTO credit_mutations
        (user_id, delta, source, reason, admin_id, idempotency_key, metadata)
       VALUES ($1, 0, 'admin_adjustment', $2, $3, $4, $5)`,
      [
        userId,
        reason ?? (blocked ? 'admin block' : 'admin unblock'),
        adminId,
        `block:${userId}:${Date.now()}`,
        { blocked },
      ],
    );
  }

  /** Resets daily_free credits for eligible free-tier users (idempotent per day). */
  async resetDailyFree(today: string = isoDate()): Promise<number> {
    const result = await this.opts.pg.query(
      `WITH eligible AS (
         SELECT id FROM users
          WHERE plan = 'free'
            AND (last_free_grant_date IS NULL OR last_free_grant_date < $1::date)
       )
       UPDATE users SET credits = credits + $2, last_free_grant_date = $1::date
        WHERE id IN (SELECT id FROM eligible)
       RETURNING id`,
      [today, this.opts.freeDailyCredits],
    );
    return result.rowCount ?? 0;
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.opts.pg.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async findMutation(client: PoolClient, idempotencyKey: string): Promise<boolean> {
    const r = await client.query(
      `SELECT 1 FROM credit_mutations WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey],
    );
    return (r.rowCount ?? 0) > 0;
  }

  private async recordMutation(client: PoolClient, m: CreditMutation): Promise<void> {
    await client.query(
      `INSERT INTO credit_mutations
        (user_id, delta, source, reason, admin_id, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [m.userId, m.delta, m.source, m.reason, m.adminId, m.idempotencyKey, m.metadata],
    );
  }

  private async getUserForUpdate(client: PoolClient, userId: string): Promise<UserBalance> {
    const r = await client.query<UserRow>(
      `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (r.rowCount === 0 || !r.rows[0]) throw new Error(`User ${userId} not found`);
    return this.row2balance(r.rows[0]);
  }

  private row2balance(row: UserRow): UserBalance {
    return {
      userId: row.id,
      telegramId: Number(row.telegram_id),
      credits: row.credits,
      plan: row.plan,
      planExpiresAtMs: row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : null,
      lifetimeCreditsUsed: row.lifetime_credits_used,
      isBlocked: row.is_blocked,
      lastActiveAtMs: row.last_active_at ? new Date(row.last_active_at).getTime() : null,
    };
  }
}

interface UserRow {
  id: string;
  telegram_id: string;
  credits: number;
  plan: PlanId;
  plan_expires_at: string | Date | null;
  lifetime_credits_used: number;
  is_blocked: boolean;
  last_active_at: string | Date | null;
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
