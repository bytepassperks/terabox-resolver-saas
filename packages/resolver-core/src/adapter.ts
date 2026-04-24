import type {
  ProviderCapabilities,
  ProviderId,
  ResolverContext,
  ResolverResult,
} from '@trs/shared-types';

/**
 * The contract every provider adapter implements. Keeping this interface
 * narrow is intentional: adapters must not know about caching, credits, or
 * rate limiting. Those concerns live in the gateway and are shared for free
 * across providers.
 */
export interface ResolverAdapter {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  /** Returns true iff this adapter can handle the given raw URL. */
  canHandle(url: URL): boolean;

  /** Extracts the provider-local stable share identifier from a URL. */
  extractShareId(url: URL): string | null;

  /**
   * Fetches the raw payload, normalizes it, and returns a ResolverResult.
   * MUST throw a ResolverError (not a plain Error) on any failure mode.
   * Implementations should be pure w.r.t. cache — the gateway handles it.
   */
  resolve(url: URL, ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult>;

  /**
   * Optional warm-cache entry: given a known shareId, re-fetch its metadata
   * and return an updated result. Used by the cron job to keep popular links
   * hot without users explicitly re-requesting them.
   */
  refreshById?(shareId: string, ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult>;
}
