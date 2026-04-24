import type { ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../../adapter.js';

/**
 * Buzzheavier adapter (scaffold). Shape is in place so the gateway can wire
 * the provider into auto-detection + fallback tables; extractor to follow.
 */
export const buzzheavierAdapter: ResolverAdapter = {
  id: 'buzzheavier',
  capabilities: {
    active: false,
    supportsStream: true,
    supportsDownload: true,
    supportsThumbnail: false,
  },
  canHandle(url: URL): boolean {
    return /(^|\.)buzzheavier\.com$/i.test(url.hostname);
  },
  extractShareId(url: URL): string | null {
    const m = /\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    return m?.[1] ?? null;
  },
  async resolve(): Promise<ResolverResult> {
    throw new ResolverError({
      code: 'PROVIDER_DISABLED',
      message: 'Buzzheavier adapter is scaffolded but not yet active',
      provider: 'buzzheavier',
      refundable: true,
      retriable: true,
    });
  },
};
