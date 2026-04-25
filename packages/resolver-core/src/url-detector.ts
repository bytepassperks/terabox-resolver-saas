import type { ProviderId } from '@trs/shared-types';
import { ResolverError } from '@trs/shared-types';

/**
 * Coarse host → provider mapping. Kept separate from adapters because some
 * providers serve multiple hostnames (TeraBox alone has ~8), and a central
 * table is easier to audit than scattered regexes across adapters.
 */
const HOST_TABLE: Array<{ match: RegExp; provider: ProviderId }> = [
  { match: /(^|\.)terabox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)1024terabox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)teraboxapp\.com$/i, provider: 'terabox' },
  { match: /(^|\.)terabox\.app$/i, provider: 'terabox' },
  { match: /(^|\.)teraboxshare\.com$/i, provider: 'terabox' },
  { match: /(^|\.)teraboxlink\.com$/i, provider: 'terabox' },
  { match: /(^|\.)terafileshare\.com$/i, provider: 'terabox' },
  { match: /(^|\.)freeterabox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)1024tera\.com$/i, provider: 'terabox' },
  { match: /(^|\.)4funbox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)mirrobox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)momerybox\.com$/i, provider: 'terabox' },
  { match: /(^|\.)nephobox\.com$/i, provider: 'terabox' },
  // GoFile
  { match: /(^|\.)gofile\.io$/i, provider: 'gofile' },
  // Pixeldrain (+ short domain)
  { match: /(^|\.)pixeldrain\.com$/i, provider: 'pixeldrain' },
  { match: /(^|\.)pixeldra\.in$/i, provider: 'pixeldrain' },
  // Buzzheavier (official mirrors + legacy domains)
  { match: /(^|\.)buzzheavier\.com$/i, provider: 'buzzheavier' },
  { match: /(^|\.)bzzhr\.co$/i, provider: 'buzzheavier' },
  { match: /(^|\.)fuckingfast\.net$/i, provider: 'buzzheavier' },
  { match: /(^|\.)fuckingfast\.co$/i, provider: 'buzzheavier' },
  { match: /(^|\.)flashbang\.sh$/i, provider: 'buzzheavier' },
  { match: /(^|\.)trashbytes\.net$/i, provider: 'buzzheavier' },
  // Google Drive
  { match: /drive\.google\.com$/i, provider: 'drive' },
  { match: /docs\.google\.com$/i, provider: 'drive' },
  // Dropbox (+ direct download domain)
  { match: /(^|\.)dropbox\.com$/i, provider: 'dropbox' },
  { match: /dl\.dropboxusercontent\.com$/i, provider: 'dropbox' },
  // OneDrive
  { match: /(1drv\.ms|onedrive\.live\.com)$/i, provider: 'onedrive' },
  // MediaFire (+ short domain)
  { match: /(^|\.)mediafire\.com$/i, provider: 'mediafire' },
  { match: /(^|\.)mfi\.re$/i, provider: 'mediafire' },
  // Krakenfiles
  { match: /(^|\.)krakenfiles\.com$/i, provider: 'krakenfiles' },
  // WorkUpload
  { match: /(^|\.)workupload\.com$/i, provider: 'workupload' },
  // Send.cm
  { match: /(^|\.)send\.cm$/i, provider: 'sendcm' },
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
