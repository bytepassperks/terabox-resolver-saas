import type { ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../../adapter.js';
import { extractPasswordFromUrl, refreshTeraboxShare } from './refresh.js';

/**
 * TeraBox surl extractor. Accepts any of these layouts:
 *   https://terabox.com/s/1XYZ           → surl = "1XYZ"
 *   https://www.terabox.com/sharing/link?surl=1XYZ → surl = "1XYZ"
 *   https://1024terabox.com/s/1_uvqm...  → surl = "1_uvqm..."
 *
 * NOTE: The leading "1" is NOT stripped — it is part of the surl identifier.
 * The shorturlinfo API requires the full surl including the "1".
 */
function parseShortUrl(url: URL): string | null {
  const sParam = url.searchParams.get('surl');
  if (sParam) return sParam;
  const pathMatch = /\/s\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (pathMatch?.[1]) return pathMatch[1];
  return null;
}

export const teraboxAdapter: ResolverAdapter = {
  id: 'terabox',
  capabilities: {
    active: true,
    supportsStream: true,
    supportsDownload: true,
    supportsThumbnail: true,
  },

  canHandle(url: URL): boolean {
    const h = url.hostname.toLowerCase();
    return /(?:^|\.)(?:terabox\.com|1024terabox\.com|teraboxapp\.com|terabox\.app|teraboxshare\.com|teraboxlink\.com|terafileshare\.com|freeterabox\.com|1024tera\.com|4funbox\.com|mirrobox\.com|momerybox\.com|nephobox\.com)$/i.test(h);
  },

  extractShareId(url: URL): string | null {
    return parseShortUrl(url);
  },

  async resolve(url: URL, _ctx: ResolverContext, signal: AbortSignal, password?: string): Promise<ResolverResult> {
    const shareId = parseShortUrl(url);
    if (!shareId) {
      throw new ResolverError({
        code: 'INVALID_SHARE_LINK',
        message: 'TeraBox URL did not contain a surl / share slug',
        provider: 'terabox',
        refundable: true,
        retriable: false,
      });
    }
    const urlPassword = extractPasswordFromUrl(url.href);
    const effectivePassword = password ?? urlPassword ?? undefined;
    return refreshTeraboxShare(shareId, signal, effectivePassword);
  },

  async refreshById(shareId: string, _ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    return refreshTeraboxShare(shareId, signal);
  },
};
