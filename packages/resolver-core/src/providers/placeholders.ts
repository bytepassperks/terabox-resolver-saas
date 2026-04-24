import type { ProviderId, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../adapter.js';

/**
 * Inactive adapter stubs for future unlocker expansion. These keep the
 * registry honest (auto-detection knows the host, canHandle returns true)
 * while making it very obvious the adapter still needs implementation.
 *
 * Each returns PROVIDER_DISABLED on `resolve`, which the fallback chain
 * treats as a retriable skip.
 */
export function makePlaceholderAdapter(id: ProviderId, hostRegex: RegExp): ResolverAdapter {
  return {
    id,
    capabilities: {
      active: false,
      supportsStream: false,
      supportsDownload: false,
      supportsThumbnail: false,
    },
    canHandle(url: URL): boolean {
      return hostRegex.test(url.hostname);
    },
    extractShareId(url: URL): string | null {
      return url.pathname.replace(/^\//, '').split('/').filter(Boolean).join('-') || null;
    },
    async resolve(): Promise<ResolverResult> {
      throw new ResolverError({
        code: 'PROVIDER_DISABLED',
        message: `Adapter '${id}' is a placeholder pending implementation`,
        provider: id,
        refundable: true,
        retriable: true,
      });
    },
  };
}

export const drivePlaceholder = makePlaceholderAdapter('drive', /drive\.google\.com$/i);
export const dropboxPlaceholder = makePlaceholderAdapter('dropbox', /(^|\.)dropbox\.com$/i);
export const onedrivePlaceholder = makePlaceholderAdapter(
  'onedrive',
  /(1drv\.ms|onedrive\.live\.com)$/i,
);
export const mediafirePlaceholder = makePlaceholderAdapter(
  'mediafire',
  /(^|\.)mediafire\.com$/i,
);
