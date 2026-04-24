import type { ResolverResult } from '@trs/shared-types';
import type { TeraboxFileEntry } from './types.js';

/**
 * Converts TeraBox's raw listing + download response into the canonical
 * ResolverResult shape. Every quirk of the upstream payload (string-number
 * sizes, optional thumbnails, etc.) is handled here so downstream consumers
 * never see a TeraBox-specific edge case.
 */
export function normalizeTeraboxResult(input: {
  shareId: string;
  file: TeraboxFileEntry;
  dlink: string;
  /** Explicit streaming URL (e.g. from /share/streaming CDN). */
  streamUrl?: string;
  expiresInSeconds: number | null;
}): ResolverResult {
  const { shareId, file, dlink, expiresInSeconds } = input;
  const thumbnail = pickThumbnail(file.thumbs);
  const size = typeof file.size === 'string' ? Number(file.size) : file.size;
  const mimeType = inferMimeType(file.server_filename);
  return {
    provider: 'terabox',
    shareId,
    fileName: file.server_filename ?? null,
    fileSizeBytes: Number.isFinite(size) ? size : null,
    mimeType,
    thumbnailUrl: thumbnail,
    streamUrl: input.streamUrl ?? buildStreamUrl(dlink, mimeType),
    downloadUrl: dlink,
    expiresAtMs: expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null,
    cached: false,
    raw: {
      fs_id: file.fs_id,
      md5: file.md5,
      category: file.category,
    },
  };
}

function pickThumbnail(thumbs: TeraboxFileEntry['thumbs']): string | null {
  if (!thumbs) return null;
  return thumbs.url3 ?? thumbs.url2 ?? thumbs.url1 ?? null;
}

function buildStreamUrl(dlink: string, mime: string | null): string | null {
  // Videos/audios play directly from dlink in most browsers/MX Player clients.
  if (mime?.startsWith('video/') || mime?.startsWith('audio/')) return dlink;
  return null;
}

function inferMimeType(name: string | undefined | null): string | null {
  if (!name) return null;
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  const table: Record<string, string> = {
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    wav: 'audio/wav',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
  };
  return table[ext] ?? null;
}
