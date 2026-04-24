import type { BotPoolEntry } from '@trs/shared-types';

export type { BotPoolEntry };

export interface TokenStatsDelta {
  tokenId: string;
  latencyMs?: number;
  failed?: boolean;
  retryAfterMs?: number;
  queueDelta?: number;
}

export interface TokenPoolConfig {
  keyPrefix: string;
  /** Minimum health score below which a token is auto-quarantined. */
  quarantineThreshold: number;
  /** Seconds a quarantined token stays sidelined before probation. */
  quarantineCooldownSeconds: number;
  /** Rolling-window size (seconds) for scoring inputs. */
  statsWindowSeconds: number;
}
