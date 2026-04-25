import { request } from 'undici';
import type { ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../../adapter.js';

const VALID_HOSTS = [
  'buzzheavier.com',
  'bzzhr.co',
  'fuckingfast.net',
  'fuckingfast.co',
  'flashbang.sh',
  'trashbytes.net',
];

function extractTitleFromHtml(html: string): string | null {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m?.[1]?.trim() ?? null;
}

export const buzzheavierAdapter: ResolverAdapter = {
  id: 'buzzheavier',
  capabilities: {
    active: true,
    supportsStream: true,
    supportsDownload: true,
    supportsThumbnail: false,
  },

  canHandle(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return VALID_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  },

  extractShareId(url: URL): string | null {
    const m = /\/([A-Za-z0-9]{8,})/.exec(url.pathname);
    return m?.[1] ?? null;
  },

  async resolve(url: URL, _ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    const shareId = this.extractShareId(url);
    if (!shareId) {
      throw new ResolverError({
        code: 'INVALID_SHARE_LINK',
        message: 'Buzzheavier URL did not contain a file id',
        provider: 'buzzheavier',
        refundable: true,
        retriable: false,
      });
    }

    const pageUrl = url.toString();

    const pageRes = await request(pageUrl, {
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
      signal,
    });

    if (pageRes.statusCode === 404) {
      throw new ResolverError({
        code: 'CONTENT_NOT_FOUND',
        message: 'Buzzheavier file not found',
        provider: 'buzzheavier',
        refundable: true,
        retriable: false,
      });
    }

    if (pageRes.statusCode >= 500) {
      throw new ResolverError({
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: `Buzzheavier HTTP ${pageRes.statusCode}`,
        provider: 'buzzheavier',
        refundable: true,
        retriable: true,
      });
    }

    const html = await pageRes.body.text();
    const fileName = extractTitleFromHtml(html);

    const downloadUrl = `${pageUrl}${pageUrl.endsWith('/') ? '' : '/'}download`;
    const headRes = await request(downloadUrl, {
      method: 'HEAD',
      headers: {
        'hx-current-url': pageUrl,
        'hx-request': 'true',
        referer: pageUrl,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
      },
      signal,

    }).catch(() => null);

    const hxRedirect = headRes?.headers?.['hx-redirect'] as string | undefined;

    if (!hxRedirect) {
      throw new ResolverError({
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: 'Buzzheavier did not return a download redirect',
        provider: 'buzzheavier',
        refundable: true,
        retriable: true,
      });
    }

    const finalUrl = hxRedirect.startsWith('http')
      ? hxRedirect
      : `${url.origin}${hxRedirect}`;

    const ext = fileName?.split('.').pop()?.toLowerCase() ?? '';
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv'];
    const audioExts = ['mp3', 'flac', 'ogg', 'wav', 'aac', 'm4a'];
    const isStreamable = videoExts.includes(ext) || audioExts.includes(ext);

    return {
      provider: 'buzzheavier',
      shareId,
      fileName: fileName ?? null,
      fileSizeBytes: null,
      mimeType: null,
      thumbnailUrl: null,
      streamUrl: isStreamable ? finalUrl : null,
      downloadUrl: finalUrl,
      expiresAtMs: null,
      cached: false,
      raw: { hxRedirect },
    };
  },
};
