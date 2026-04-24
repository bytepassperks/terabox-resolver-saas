import type { ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import { fetchDownloadLink, fetchSession, fetchShareList } from './extract.js';
import { normalizeTeraboxResult } from './normalize.js';

/**
 * Refreshes a known TeraBox shareId: runs the extractor again and produces a
 * fresh ResolverResult. Used by the warm-cache cron and by the gateway when
 * it detects `expiresAtMs` is within the safety margin.
 *
 * Kept separate from the initial-resolve path so the two call sites can evolve
 * independently (e.g. the cron might want to skip adapters that are currently
 * quarantined, while user-initiated resolves want the fallback chain behavior).
 */
export async function refreshTeraboxShare(shareId: string, signal: AbortSignal): Promise<ResolverResult> {
  const session = await fetchSession(shareId, signal);
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

  const dl = await fetchDownloadLink(session, list.share_id, list.uk, first.fs_id, signal);
  return normalizeTeraboxResult({
    shareId,
    file: first,
    dlink: dl.dlink,
    expiresInSeconds: dl.expiration ?? null,
  });
}
