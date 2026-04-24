export type PlanId = 'free' | 'starter' | 'basic' | 'pro' | 'power' | 'ultra';

export interface PlanDefinition {
  id: PlanId;
  /** Human-friendly name shown in the bot. */
  name: string;
  /** One-time credits granted on purchase (for paid plans). */
  credits: number;
  /** Stars price. 0 = free. */
  stars: number;
  /** Rate-limit tier this plan unlocks. */
  rateTier: 'free' | 'paid' | 'premium';
  /** Days until the plan expires (null = lifetime). */
  validityDays: number | null;
}

export type CreditMutationSource =
  | 'resolve_success'
  | 'resolve_refund'
  | 'stars_payment'
  | 'admin_adjustment'
  | 'daily_free'
  | 'redeem_code'
  | 'bonus';

export interface CreditMutation {
  userId: string;
  delta: number;
  source: CreditMutationSource;
  reason: string | null;
  adminId: string | null;
  /** Unique key that prevents duplicate application (e.g. stars charge id). */
  idempotencyKey: string;
  metadata: Record<string, unknown> | null;
}

export interface UserBalance {
  userId: string;
  telegramId: number;
  credits: number;
  plan: PlanId;
  planExpiresAtMs: number | null;
  lifetimeCreditsUsed: number;
  isBlocked: boolean;
  lastActiveAtMs: number | null;
}
