/**
 * Multi-bot router identifies each bot token with a stable pool-local ID
 * (NOT the token itself — tokens never leave the router's memory).
 */
export interface BotPoolEntry {
  id: string;
  /** Masked token suffix for logs (e.g. "…AAZq"). Safe to log. */
  tokenTail: string;
  /** True when the entry is eligible for new assignments. */
  healthy: boolean;
  /** 0-100 composite score; higher = healthier. */
  healthScore: number;
  /** Milliseconds of average recent Telegram API latency. */
  latencyMs: number;
  /** Rolling-window failure rate [0..1]. */
  failureRate: number;
  /** Rolling-window 429/retry_after frequency. */
  retryRate: number;
  /** Current outstanding request count. */
  queueDepth: number;
  /** Unix millis when entry was last quarantined (null if never). */
  quarantinedAtMs: number | null;
}

export interface StarsPaymentEvent {
  telegramChargeId: string;
  providerPaymentChargeId: string | null;
  telegramUserId: number;
  amountStars: number;
  /** JSON payload attached to the invoice (typically plan + credits). */
  payload: Record<string, unknown>;
  receivedAtMs: number;
}
