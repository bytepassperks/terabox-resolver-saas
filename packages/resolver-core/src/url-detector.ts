import type { ProviderId } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';

/**
 * Coarse host → provider mapping. Kept separate from adapters because some
 * providers serve multiple hostnames (TeraBox alone has ~8), and a central
 * table is easier to audit than scattered regexes across adapters.
 */
const HOST_TABLE: Array<{ match: RegExp; provider: ProviderId }> = [
  { match: /(^|\.)terabox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)teraboxapp\.com$/i, provider: 'terabox' },
  { match: /(^|\.)teraboxshare\.com$/i, provider: 'terabox' },
  { match: /(^|\.)1024tera\.com$/i, provider: 'terabox' },
  { match: /(^|\.)4funbox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)mirrobox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)momerybox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)nephobox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)gofile\.io$/i, provider: 'gofile' },
  { match: /(^|\.)pixeldrain\.com$/i, provider: 'pixeldrain' },
  { match: /(^|\.)buzzheavier\.com$/i, provider: 'buzzheavier' },
  { match: /drive\.google\.com$/i, provider: 'drive' },
  { match: /(^|\.)dropbox\.com$/i, provider: 'dropbox' },
  { match: /(1drv\.ms|onedrive\.live\.com)$/i, provider: 'onedrive' },
  { match: /(^|\.)mediafire\.com$/i, provider: 'mediafire' },
];

export function detectProvider(rawUrl: string): { url: URL; provider: ProviderId } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ResolverError({
      code: 'UNSUPPORTED_URL',
      message: 'URL could not be parsed',
      refundable: true,
      retriable: false,
    });
  }
  const host = parsed.hostname.toLowerCase();
  for (const { match, provider } of HOST_TABLE) {
    if (match.test(host)) return { url: parsed, provider };
  }
  throw new ResolverError({
    code: 'UNSUPPORTED_URL',
    message: `Unsupported host: ${host}`,
    refundable: true,
    retriable: false,
  });
}
