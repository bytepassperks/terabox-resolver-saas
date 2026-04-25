import type { Pool } from 'pg';
import type { Logger } from '@trs/logger';
import type { AccountPoolConfig, AccountStatus, ProviderAccount } from './types.js';
import { DEFAULT_ACCOUNT_POOL_CONFIG } from './types.js';

/**
 * AccountPool — manages upstream provider account cookies.
 *
 * Selection strategy: pick the active account with the oldest `last_used_at`
 * (least-recently-used) to spread load evenly across accounts.
 *
 * Health tracking: each resolve attempt calls `recordSuccess()` or
 * `recordFailure()`. After N consecutive failures the account is automatically
 * set to `cooldown` (or `disabled` if it keeps failing after cooldown).
 */
export class AccountPool {
  private readonly cfg: AccountPoolConfig;

  constructor(
    private readonly pg: Pool,
    private readonly log: Logger,
    cfg?: Partial<AccountPoolConfig>,
  ) {
    this.cfg = { ...DEFAULT_ACCOUNT_POOL_CONFIG, ...cfg };
  }

  /**
   * Pick the best available account for a provider. Returns `null` if no
   * accounts are available (caller should fall back to anonymous).
   */
  async acquire(provider: string): Promise<ProviderAccount | null> {
    // Promote cooldown accounts whose cooldown has expired
    await this.pg.query(
      `UPDATE provider_accounts
         SET status = 'active', consecutive_failures = 0, updated_at = NOW()
       WHERE provider = $1 AND status = 'cooldown' AND cooldown_until <= NOW()`,
      [provider],
    );

    // Expire accounts past their expiry date
    await this.pg.query(
      `UPDATE provider_accounts
         SET status = 'expired', updated_at = NOW()
       WHERE provider = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`,
      [provider],
    );

    // Pick least-recently-used active account
    const { rows } = await this.pg.query<ProviderAccountRow>(
      `UPDATE provider_accounts
         SET last_used_at = NOW(), usage_count = usage_count + 1, updated_at = NOW()
       WHERE id = (
         SELECT id FROM provider_accounts
         WHERE provider = $1 AND status = 'active'
         ORDER BY last_used_at ASC NULLS FIRST
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [provider],
    );

    if (rows.length === 0) return null;
    return mapRow(rows[0]!);
  }

  /** Record a successful resolve using this account. */
  async recordSuccess(accountId: string): Promise<void> {
    await this.pg.query(
      `UPDATE provider_accounts
         SET success_count = success_count + 1,
             consecutive_failures = 0,
             last_success_at = NOW(),
             updated_at = NOW()
       WHERE id = $1`,
      [accountId],
    );
  }

  /** Record a failed resolve. May trigger cooldown or disable. */
  async recordFailure(accountId: string): Promise<void> {
    const { rows } = await this.pg.query<ProviderAccountRow>(
      `UPDATE provider_accounts
         SET failure_count = failure_count + 1,
             consecutive_failures = consecutive_failures + 1,
             last_failure_at = NOW(),
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [accountId],
    );
    if (rows.length === 0) return;
    const acct = rows[0]!;
    const consec = acct.consecutive_failures;

    if (consec >= this.cfg.maxConsecutiveFailures * 2) {
      // Too many consecutive failures even after cooldown — disable permanently
      await this.pg.query(
        `UPDATE provider_accounts SET status = 'disabled', updated_at = NOW() WHERE id = $1`,
        [accountId],
      );
      this.log.warn({ accountId, consec }, 'account-pool: disabled after repeated failures');
    } else if (consec >= this.cfg.maxConsecutiveFailures) {
      // Put into cooldown
      const cooldownUntil = new Date(Date.now() + this.cfg.cooldownMs);
      await this.pg.query(
        `UPDATE provider_accounts SET status = 'cooldown', cooldown_until = $2, updated_at = NOW() WHERE id = $1`,
        [accountId, cooldownUntil.toISOString()],
      );
      this.log.warn({ accountId, consec, cooldownUntil }, 'account-pool: account in cooldown');
    }
  }

  /** Add a new account cookie. */
  async addAccount(opts: {
    provider: string;
    cookie: string;
    label?: string;
    expiresAt?: Date;
    addedBy?: string;
  }): Promise<ProviderAccount> {
    const { rows } = await this.pg.query<ProviderAccountRow>(
      `INSERT INTO provider_accounts (provider, cookie, label, expires_at, added_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [opts.provider, opts.cookie, opts.label ?? null, opts.expiresAt?.toISOString() ?? null, opts.addedBy ?? null],
    );
    return mapRow(rows[0]!);
  }

  /** Remove an account by ID. */
  async removeAccount(accountId: string): Promise<boolean> {
    const { rowCount } = await this.pg.query(
      `DELETE FROM provider_accounts WHERE id = $1`,
      [accountId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Update an account's status manually. */
  async setStatus(accountId: string, status: AccountStatus): Promise<void> {
    await this.pg.query(
      `UPDATE provider_accounts SET status = $2, updated_at = NOW() WHERE id = $1`,
      [accountId, status],
    );
  }

  /** Update an account's cookie (e.g., after manual re-login). */
  async updateCookie(accountId: string, cookie: string): Promise<void> {
    await this.pg.query(
      `UPDATE provider_accounts
         SET cookie = $2, status = 'active', consecutive_failures = 0, updated_at = NOW()
       WHERE id = $1`,
      [accountId, cookie],
    );
  }

  /** List all accounts for a provider. */
  async listAccounts(provider?: string): Promise<ProviderAccount[]> {
    const { rows } = provider
      ? await this.pg.query<ProviderAccountRow>(
          `SELECT * FROM provider_accounts WHERE provider = $1 ORDER BY created_at DESC`,
          [provider],
        )
      : await this.pg.query<ProviderAccountRow>(
          `SELECT * FROM provider_accounts ORDER BY provider, created_at DESC`,
        );
    return rows.map(mapRow);
  }

  /** Get health summary for a provider. */
  async getHealth(provider: string): Promise<{
    total: number;
    active: number;
    cooldown: number;
    disabled: number;
    expired: number;
  }> {
    const { rows } = await this.pg.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM provider_accounts WHERE provider = $1 GROUP BY status`,
      [provider],
    );
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = Number(r.count);
    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      active: counts['active'] ?? 0,
      cooldown: counts['cooldown'] ?? 0,
      disabled: counts['disabled'] ?? 0,
      expired: counts['expired'] ?? 0,
    };
  }
}

// ─── Row mapping ────────────────────────────────────────────────────────────

interface ProviderAccountRow {
  id: string;
  provider: string;
  label: string | null;
  cookie: string;
  status: AccountStatus;
  usage_count: string;
  success_count: string;
  failure_count: string;
  consecutive_failures: number;
  last_used_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  cooldown_until: Date | null;
  expires_at: Date | null;
  added_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: ProviderAccountRow): ProviderAccount {
  return {
    id: r.id,
    provider: r.provider,
    label: r.label,
    cookie: r.cookie,
    status: r.status,
    usageCount: Number(r.usage_count),
    successCount: Number(r.success_count),
    failureCount: Number(r.failure_count),
    consecutiveFailures: r.consecutive_failures,
    lastUsedAt: r.last_used_at,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    cooldownUntil: r.cooldown_until,
    expiresAt: r.expires_at,
    addedBy: r.added_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
