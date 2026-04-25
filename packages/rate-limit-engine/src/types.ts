export type RateTier = 'free' | 'paid' | 'premium';

export interface RateLimitConfig {
  freeWindowSeconds: number;
  paidWindowSeconds: number;
  premiumWindowSeconds: number;
  /** Per-IP ceiling to catch scrapers who cycle telegram accounts. */
  ipPerMinute: number;
  /** Namespace prefix (shared with cache-layer). */
  keyPrefix: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  reason: 'ok' | 'user_window' | 'ip_window' | 'abuse_heuristic';
}

export interface AbuseDecision {
  /** True if the request should be rejected outright. */
  block: boolean;
  /** True if the request should be silently slowed or queued. */
  shadowThrottle: boolean;
  /** True if the incident should be surfaced to admins. */
  adminFlag: boolean;
  score: number;
  signals: string[];
}
