import type { ResolverResult } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';
import { fetchDownloadLink, fetchSession, fetchShareList, verifyPassword } from './extract.js';
import { normalizeTeraboxResult } from './normalize.js';

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
 * fresh ResolverResult. Used by the warm-cache cron and by the gateway when
 * it detects `expiresAtMs` is within the safety margin.
 */
export async function refreshTeraboxShare(
  shareId: string,
  signal: AbortSignal,
  password?: string,
): Promise<ResolverResult> {
  let session = await fetchSession(shareId, signal);

  try {
    const list = await fetchShareList(session, signal);
    return await buildResult(shareId, list, session, signal);
  } catch (err) {
    if (ResolverError.is(err) && err.code === 'CONTENT_PASSWORD_PROTECTED') {
      if (!password) throw err;

      // Verify password and retry
      session = await verifyPassword(session, password, signal);
      const list = await fetchShareList(session, signal);
      const result = await buildResult(shareId, list, session, signal);
      return { ...result, unlocked: true, unlockSource: 'password' };
    }
    throw err;
  }
}

async function buildResult(
  shareId: string,
  list: Awaited<ReturnType<typeof fetchShareList>>,
  session: Awaited<ReturnType<typeof fetchSession>>,
  signal: AbortSignal,
): Promise<ResolverResult> {
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
