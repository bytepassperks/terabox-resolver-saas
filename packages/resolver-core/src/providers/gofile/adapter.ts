import { request } from 'undici';
import type { ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../../adapter.js';

/**
 * GoFile adapter. GoFile exposes a public JSON API which returns file contents
 * for a share at /contents?contentId=... — full implementation is a separate
 * maintenance task; this stub registers the adapter with reasonable URL
 * detection + share-id extraction so the router can offer it as a fallback
 * candidate today.
 *
 * TODO: implement getAccountToken(), fetch `contents` with bearer, map entries.
 */
export const gofileAdapter: ResolverAdapter = {
  id: 'gofile',
  capabilities: {
    active: false,
    supportsStream: true,
    supportsDownload: true,
    supportsThumbnail: false,
  },

  canHandle(url: URL): boolean {
    return /(^|\.)gofile\.io$/i.test(url.hostname);
  },

  extractShareId(url: URL): string | null {
    const m = /\/d\/([A-Za-z0-9]+)/.exec(url.pathname);
    return m?.[1] ?? null;
  },

  async resolve(_url: URL, _ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    // Sanity check the API is reachable (keeps the adapter honest in metrics
    // even while the extractor is still TODO).
    await request('https://api.gofile.io/servers', { method: 'GET', signal }).catch(() => undefined);
    throw new ResolverError({
      code: 'PROVIDER_DISABLED',
      message: 'GoFile adapter is scaffolded but not yet active',
      provider: 'gofile',
      refundable: true,
      retriable: true,
    });
  },
};
