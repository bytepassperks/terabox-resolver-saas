import type { PlanDefinition, PlanId } from '@trs/shared-types';

/**
 * Stars-native pricing ladder. Stars ↔ INR conversion is set by Telegram at
 * payout time; the ratios here are based on the blueprint's suggested
 * profit-optimized staircase. Tweak freely — rate limits + credit grants are
 * the only fields the rest of the codebase consumes.
 */
export const PLAN_DEFINITIONS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    credits: 3,
    stars: 0,
    rateTier: 'free',
    validityDays: null,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    credits: 100,
    stars: 50,
    rateTier: 'paid',
    validityDays: 30,
  },
  basic: {
    id: 'basic',
    name: 'Basic',
    credits: 250,
    stars: 100,
    rateTier: 'paid',
    validityDays: 30,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    credits: 700,
    stars: 250,
    rateTier: 'premium',
    validityDays: 30,
  },
  power: {
    id: 'power',
    name: 'Power',
    credits: 2000,
    stars: 500,
    rateTier: 'premium',
    validityDays: 60,
  },
  ultra: {
    id: 'ultra',
    name: 'Ultra',
    credits: 5000,
    stars: 799,
    rateTier: 'premium',
    validityDays: 90,
  },
};

export const PAID_PLAN_IDS: readonly PlanId[] = ['starter', 'basic', 'pro', 'power', 'ultra'];

export function getPlan(id: PlanId): PlanDefinition {
  return PLAN_DEFINITIONS[id];
}

/**
 * Matches the JSON payload attached to a Stars invoice back to a plan.
 * We trust only the `planId` field; Stars amount is re-validated server-side.
 */
export function planFromInvoicePayload(payload: unknown): PlanDefinition | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { planId?: unknown };
  if (typeof p.planId !== 'string') return null;
  if (!(p.planId in PLAN_DEFINITIONS)) return null;
  return PLAN_DEFINITIONS[p.planId as PlanId];
}
