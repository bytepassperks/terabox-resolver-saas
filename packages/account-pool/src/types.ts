export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'expired';

export interface ProviderAccount {
  id: string;
  provider: string;
  label: string | null;
  cookie: string;
  status: AccountStatus;
  usageCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastUsedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  cooldownUntil: Date | null;
  expiresAt: Date | null;
  addedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountPoolConfig {
  /** Max consecutive failures before auto-disabling. Default: 5. */
  maxConsecutiveFailures: number;
  /** Cooldown duration in ms after a failure burst. Default: 5 min. */
  cooldownMs: number;
  /** If true, prefer least-recently-used account. Default: true. */
  lruSelection: boolean;
}

export const DEFAULT_ACCOUNT_POOL_CONFIG: AccountPoolConfig = {
  maxConsecutiveFailures: 5,
  cooldownMs: 5 * 60 * 1000,
  lruSelection: true,
};
