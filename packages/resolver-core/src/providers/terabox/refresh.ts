import type { ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import type { RelayClient } from '@trs/worker-relay-client';
import {
  fetchAuthenticatedDownload,
  fetchDownloadLink,
  fetchSession,
  fetchShareList,
  fetchShortUrlInfo,
  fetchStreamingUrl,
  verifyPassword,
} from './extract.js';
import { normalizeTeraboxResult } from './normalize.js';
import type { TeraboxShortUrlInfoResponse } from './types.js';

/**
 * Extracts password from a TeraBox URL (e.g. ?pwd=abcd).
 */
export function extractPasswordFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('pwd') ?? null;
  } catch {
    return null;
  }
}

/**
 * Refreshes a known TeraBox shareId: runs the extractor again and produces a
 * fresh ResolverResult.
 *
 * CF Worker flow (when accountCookie + relayClient are available):
 *   → POST /resolve to CF Worker which runs the full extraction from CF edge.
 *     CF edge bypasses the "need verify_v2" that datacenter IPs get.
 *
 * Fallback anonymous flow (no account cookie):
 *   1. fetchSession       → jsToken + cookies
 *   2. fetchShortUrlInfo  → file metadata, sign, timestamp, BDCLND cookie,
 *                           shareid, uk — this is the primary data source
 *   3. fetchStreamingUrl  → m3u8 CDN URL (stream + download)
 *
 * Password flow:
 *   1–2  same as above
 *   3. shorturlinfo detects password-protected (errno 105 or no list)
 *   4. verifyPassword     → BDCLND cookie from verify
 *   5. fetchShareList     → file metadata (now works after password verify)
 *   6. fetchStreamingUrl  → m3u8 CDN URL
 */
export async function refreshTeraboxShare(
  shareId: string,
  signal: AbortSignal,
  password?: string,
  accountCookie?: string,
  relayClient?: RelayClient,
): Promise<ResolverResult> {
  // When we have an account cookie AND a relay client, use the CF Worker
  // resolve endpoint. This runs the full TeraBox extraction from CF edge,
  // bypassing the "need verify_v2" error that datacenter IPs get.
  if (accountCookie && relayClient) {
    try {
      const cfResult = await relayClient.resolveTerabox(
        shareId, accountCookie, password, signal,
      );
      if (cfResult.errno === 0 && cfResult.files?.length) {
        const first = cfResult.files[0]!;
        const dlink = first.dlink ?? cfResult.dlink;
        if (dlink) {
          return normalizeTeraboxResult({
            shareId,
            file: {
              fs_id: first.fs_id,
              server_filename: first.server_filename,
              size: first.size,
              isdir: first.isdir,
              category: first.category,
              md5: first.md5 ?? '',
              thumbs: first.thumbs,
            },
            dlink,
            streamUrl: undefined,
            expiresInSeconds: 28800,
          });
        }
        // CF resolve returned files but no dlink — fall through
      }
      if (cfResult.errno === 105) {
        throw new ResolverError({
          code: 'CONTENT_PASSWORD_PROTECTED',
          message: 'TeraBox: password-protected link',
          provider: 'terabox',
          refundable: true,
          retriable: false,
        });
      }
      // CF resolve failed — fall through to direct approach
    } catch (err) {
      if (ResolverError.is(err)) throw err;
      // Network error to CF worker — fall through
    }
  }

  let session = await fetchSession(shareId, signal);

  // Fetch shorturlinfo — primary data source.
  let info: TeraboxShortUrlInfoResponse;
  try {
    const result = await fetchShortUrlInfo(session, signal);
    session = result.session;
    info = result.info;
  } catch (err) {
    if (ResolverError.is(err) && err.code === 'CONTENT_PASSWORD_PROTECTED') {
      if (!password) throw err;
      session = await verifyPassword(session, password, signal);
      return await passwordFlow(shareId, session, signal, accountCookie);
    }
    throw err;
  }

  // shorturlinfo returned data — check if we have files
  const files = info.list;
  if (!files || files.length === 0) {
    throw new ResolverError({
      code: 'CONTENT_NOT_FOUND',
      message: 'TeraBox share contained no files',
      provider: 'terabox',
      refundable: true,
      retriable: false,
    });
  }

  if (!info.shareid || !info.uk) {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'TeraBox shorturlinfo missing shareid or uk',
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }

  // files[0] is guaranteed after the length check above
  const first = files[0]!;

  // When an account cookie is available, try authenticated download directly.
  if (accountCookie) {
    try {
      const dl = await fetchAuthenticatedDownload(
        session, info.shareid, info.uk, first.fs_id, accountCookie, signal,
      );
      let streamUrl: string | undefined;
      try {
        const streaming = await fetchStreamingUrl(
          session, info.shareid, info.uk, first.fs_id, signal,
        );
        streamUrl = streaming.streamUrl;
      } catch {
        // streaming is optional when we have a real dlink
      }
      return normalizeTeraboxResult({
        shareId,
        file: first,
        dlink: dl.dlink,
        streamUrl,
        expiresInSeconds: dl.expiration ?? 28800,
      });
    } catch {
      // Authenticated download failed — fall through to streaming
    }
  }

  // Try streaming URL (works without share/download, but returns small segment)
  try {
    const { streamUrl, downloadUrl } = await fetchStreamingUrl(
      session,
      info.shareid,
      info.uk,
      first.fs_id,
      signal,
    );
    return normalizeTeraboxResult({
      shareId,
      file: first,
      dlink: downloadUrl,
      streamUrl,
      expiresInSeconds: 28800,
    });
  } catch {
    // streaming failed — fall back to share/download
  }

  // Fallback: try share/download (may fail with verify_v2 for anon sessions)
  try {
    const dl = await fetchDownloadLink(session, info.shareid, info.uk, first.fs_id, signal);
    return normalizeTeraboxResult({
      shareId,
      file: first,
      dlink: dl.dlink,
      expiresInSeconds: dl.expiration ?? null,
    });
  } catch {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'TeraBox: could not obtain download or streaming URL',
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }
}

/**
 * Password-protected flow: after verifyPassword succeeds, use share/list
 * (which now works with the BDCLND cookie from verify) then streaming.
 */
async function passwordFlow(
  shareId: string,
  session: Awaited<ReturnType<typeof fetchSession>>,
  signal: AbortSignal,
  accountCookie?: string,
): Promise<ResolverResult> {
  const list = await fetchShareList(session, signal);
  const first = list.list[0];
  if (!first) {
    throw new ResolverError({
      code: 'CONTENT_NOT_FOUND',
      message: 'TeraBox share contained no files',
      provider: 'terabox',
      refundable: true,
      retriable: false,
    });
  }
  if (!list.share_id || !list.uk) {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'TeraBox share/list missing share_id or uk',
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }

  // Try authenticated download first when account cookie is available
  if (accountCookie) {
    try {
      const dl = await fetchAuthenticatedDownload(
        session, list.share_id, list.uk, first.fs_id, accountCookie, signal,
      );
      let streamUrl: string | undefined;
      try {
        const streaming = await fetchStreamingUrl(
          session, list.share_id, list.uk, first.fs_id, signal,
        );
        streamUrl = streaming.streamUrl;
      } catch {
        // streaming is optional
      }
      const result = normalizeTeraboxResult({
        shareId,
        file: first,
        dlink: dl.dlink,
        streamUrl,
        expiresInSeconds: dl.expiration ?? 28800,
      });
      return { ...result, unlocked: true, unlockSource: 'password' };
    } catch {
      // Authenticated download failed — fall through
    }
  }

  // Try streaming, then share/download
  try {
    const { streamUrl, downloadUrl } = await fetchStreamingUrl(
      session,
      list.share_id,
      list.uk,
      first.fs_id,
      signal,
    );
    const result = normalizeTeraboxResult({
      shareId,
      file: first,
      dlink: downloadUrl,
      streamUrl,
      expiresInSeconds: 28800,
    });
    return { ...result, unlocked: true, unlockSource: 'password' };
  } catch {
    // streaming failed — fall back to share/download
  }

  const dl = await fetchDownloadLink(session, list.share_id, list.uk, first.fs_id, signal);
  const result = normalizeTeraboxResult({
    shareId,
    file: first,
    dlink: dl.dlink,
    expiresInSeconds: dl.expiration ?? null,
  });
  return { ...result, unlocked: true, unlockSource: 'password' };
}
