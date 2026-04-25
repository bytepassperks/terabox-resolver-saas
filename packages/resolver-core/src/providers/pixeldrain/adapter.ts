import { request } from 'undici';
import type { ResolverContext, ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { ResolverAdapter } from '../../adapter.js';

/**
 * Pixeldrain adapter. Pixeldrain is the simplest of the supported providers —
 * GET https://pixeldrain.com/api/file/{id}/info returns file metadata, and
 * the raw download is at https://pixeldrain.com/api/file/{id}?download.
 *
 * Enabled by default since the public API needs no auth and is stable.
 */

interface PixeldrainInfo {
  id: string;
  name: string;
  size: number;
  mime_type: string;
  thumbnail_href?: string;
  date_upload?: string;
}

export const pixeldrainAdapter: ResolverAdapter = {
  id: 'pixeldrain',
  capabilities: {
    active: true,
    supportsStream: true,
    supportsDownload: true,
    supportsThumbnail: true,
  },

  canHandle(url: URL): boolean {
    return /(^|\.)(?:pixeldrain\.com|pixeldra\.in)$/i.test(url.hostname);
  },

  extractShareId(url: URL): string | null {
    const m = /\/(?:u|l)\/([A-Za-z0-9]+)/.exec(url.pathname);
    return m?.[1] ?? null;
  },

  async resolve(url: URL, _ctx: ResolverContext, signal: AbortSignal): Promise<ResolverResult> {
    const shareId = this.extractShareId(url);
    if (!shareId) {
      throw new ResolverError({
        code: 'INVALID_SHARE_LINK',
        message: 'Pixeldrain URL did not contain a file id',
        provider: 'pixeldrain',
        refundable: true,
        retriable: false,
      });
    }
    const res = await request(`https://pixeldrain.com/api/file/${shareId}/info`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    });
    if (res.statusCode === 404) {
      throw new ResolverError({
        code: 'CONTENT_NOT_FOUND',
        message: 'Pixeldrain file not found',
        provider: 'pixeldrain',
        refundable: true,
        retriable: false,
      });
    }
    if (res.statusCode >= 500) {
      throw new ResolverError({
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: `Pixeldrain HTTP ${res.statusCode}`,
        provider: 'pixeldrain',
        refundable: true,
        retriable: true,
      });
    }
    const info = (await res.body.json()) as PixeldrainInfo;
    const dl = `https://pixeldrain.com/api/file/${shareId}?download`;
    const stream = info.mime_type.startsWith('video/') || info.mime_type.startsWith('audio/') ? dl : null;
    return {
      provider: 'pixeldrain',
      shareId,
      fileName: info.name,
      fileSizeBytes: info.size,
      mimeType: info.mime_type,
      thumbnailUrl: info.thumbnail_href ? `https://pixeldrain.com${info.thumbnail_href}` : null,
      streamUrl: stream,
      downloadUrl: dl,
      // Pixeldrain URLs don't expire; use null to signal "long-lived".
      expiresAtMs: null,
      cached: false,
      raw: { id: info.id },
    };
  },
};
