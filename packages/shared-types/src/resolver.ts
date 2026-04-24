import type { ProviderId } from './providers.js';

/**
 * Canonical, adapter-agnostic resolve output. Every provider adapter MUST
 * normalize its upstream response into this shape before it leaves the
 * resolver-core boundary. Consumers (bot, admin API, metrics, cache) are
 * only allowed to depend on this shape — never raw provider payloads.
 */
export interface ResolverResult {
  provider: ProviderId;
  /** Stable provider-local ID (e.g. TeraBox `surl`). Primary cache key. */
  shareId: string;
  fileName: string | null;
  fileSizeBytes: number | null;
  mimeType: string | null;
  thumbnailUrl: string | null;
  /** HLS / progressive stream URL if the provider exposes one. */
  streamUrl: string | null;
  /** Direct download URL (short-lived; expire tracked separately). */
  downloadUrl: string | null;
  /** Absolute unix millis when the stream/download URL stops working. */
  expiresAtMs: number | null;
  /** True when the result was served from cache (vs freshly resolved). */
  cached: boolean;
  /** Whether the share was password-protected and successfully unlocked. */
  unlocked?: boolean;
  /** How the share was unlocked (password, cache, direct_public, fallback_provider). */
  unlockSource?: 'password' | 'cache' | 'direct_public' | 'fallback_provider';
  /** True when the resolver needs the user to supply a password before it can proceed. */
  requiresPassword?: boolean;
  /** Free-form provider-specific metadata. NEVER trusted by gateway logic. */
  raw?: Record<string, unknown>;
}

export interface ResolverContext {
  /** Originating Telegram user ID (for rate limiting + logging). */
  telegramUserId?: number;
  /** Optional explicit provider override (bypasses auto-detection). */
  providerOverride?: ProviderId;
  /** Request-correlation ID (propagated through logs + metrics). */
  requestId: string;
  /** True when the caller is an admin warm-cache job (skips credit deduction). */
  isSystem?: boolean;
}

export interface ResolveRequest {
  url: string;
  context: ResolverContext;
}
