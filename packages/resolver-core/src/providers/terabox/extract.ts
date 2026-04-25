import { request } from 'undici';
import { ResolverError } from '@trs/shared-types';
import type {
  TeraboxDownloadResponse,
  TeraboxSessionContext,
  TeraboxShareListResponse,
  TeraboxShortUrlInfoResponse,
  TeraboxVerifyPasswordResponse,
} from './types.js';

/**
 * TeraBox extractor. This file is the ONLY place in the codebase that
 * understands TeraBox's current frontend flow — keep it self-contained so a
 * future ToS rotation only requires editing this one module.
 *
 * Current flow (as of April 2026):
 *   1. GET sharing page        → capture `js-token` and session cookies
 *   2. GET /api/shorturlinfo   → file metadata, sign, timestamp, randsk,
 *                                 shareid, uk (BDCLND cookie)
 *   3. GET /share/streaming    → m3u8 playlist with CDN-direct segment URLs
 *
 * Important: /share/list and /share/download are NO LONGER reliable for
 * anonymous sessions — they return errno 105 (false "password protected") and
 * errno 400310 ("need verify_v2") respectively. shorturlinfo + streaming
 * bypass both issues.
 *
 * For password-protected links, /share/verify is still used after the user
 * supplies their password, then share/list is retried.
 *
 * When TeraBox rotates, the typical failure modes are:
 *   - jsToken regex no longer matches the inlined script → PROVIDER_AUTH_EXPIRED
 *   - shorturlinfo returns errno 2 → CONTENT_NOT_FOUND
 *   - streaming returns empty/error → PROVIDER_UPSTREAM_ERROR
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const APP_ID = '250528';
const CLIENTTYPE = '0';
const WEB = '1';
const CHANNEL = 'dubox';

const JS_TOKEN_REGEX = /fn%28%22([A-Za-z0-9]+)%22%29/;
const LOGID_REGEX = /dp-logid=([A-Za-z0-9]+)/;

export async function fetchSession(shortUrl: string, signal: AbortSignal): Promise<TeraboxSessionContext> {
  const url = `https://www.terabox.com/sharing/link?surl=${encodeURIComponent(shortUrl)}`;
  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal,
  });
  if (res.statusCode === 404) {
    throw new ResolverError({
      code: 'CONTENT_NOT_FOUND',
      message: 'Share link does not exist or has been removed',
      provider: 'terabox',
      refundable: true,
      retriable: false,
    });
  }
  if (res.statusCode >= 500) {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: `TeraBox returned HTTP ${res.statusCode} on sharing page`,
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }
  const body = await res.body.text();
  const jsTokenMatch = JS_TOKEN_REGEX.exec(body);
  const logidMatch = LOGID_REGEX.exec(body);
  const jsToken = jsTokenMatch?.[1];
  const logid = logidMatch?.[1] ?? '';
  if (!jsToken) {
    throw new ResolverError({
      code: 'PROVIDER_AUTH_EXPIRED',
      message: 'Could not locate jsToken in TeraBox sharing page (frontend flow rotated?)',
      provider: 'terabox',
      refundable: true,
      retriable: false,
    });
  }
  const cookies = extractCookies(res.headers['set-cookie']);
  return { jsToken, logid, cookies, shortUrl };
}

export async function verifyPassword(
  session: TeraboxSessionContext,
  password: string,
  signal: AbortSignal,
): Promise<TeraboxSessionContext> {
  const url = new URL('https://www.terabox.com/share/verify');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('web', WEB);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('clienttype', CLIENTTYPE);
  url.searchParams.set('jsToken', session.jsToken);
  url.searchParams.set('dp-logid', session.logid);
  url.searchParams.set('shorturl', session.shortUrl);

  const body = new URLSearchParams({ pwd: password });
  const res = await request(url, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: session.cookies,
      referer: `https://www.terabox.com/sharing/link?surl=${session.shortUrl}`,
    },
    body: body.toString(),
    signal,
  });
  const json = (await res.body.json()) as TeraboxVerifyPasswordResponse;
  if (json.errno !== 0) {
    throw new ResolverError({
      code: 'INVALID_PASSWORD',
      message: 'TeraBox password verification failed',
      provider: 'terabox',
      refundable: true,
      retriable: false,
    });
  }

  const updatedCookies = extractCookies(res.headers['set-cookie']);
  const mergedCookies = updatedCookies
    ? `${session.cookies}; ${updatedCookies}`
    : session.cookies;

  return {
    ...session,
    cookies: mergedCookies,
    signData: json.sign
      ? { sign: json.sign, timestamp: json.timestamp ?? Math.floor(Date.now() / 1000) }
      : session.signData,
  };
}

/**
 * Fetch share metadata from /api/shorturlinfo. This returns sign, timestamp,
 * and randsk (used as BDCLND cookie). The returned session has BDCLND merged
 * into cookies and signData populated.
 */
export async function fetchShortUrlInfo(
  session: TeraboxSessionContext,
  signal: AbortSignal,
): Promise<{ session: TeraboxSessionContext; info: TeraboxShortUrlInfoResponse }> {
  const url = new URL('https://www.terabox.com/api/shorturlinfo');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('web', WEB);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('clienttype', CLIENTTYPE);
  url.searchParams.set('shorturl', session.shortUrl);
  url.searchParams.set('root', '1');

  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/plain, */*',
      cookie: session.cookies,
      referer: `https://www.terabox.com/sharing/link?surl=${session.shortUrl}`,
    },
    signal,
  });
  const body = (await res.body.json()) as TeraboxShortUrlInfoResponse;
  if (body.errno !== 0) {
    throw mapErrno(body.errno, 'shorturlinfo');
  }

  let updatedCookies = session.cookies;
  if (body.randsk) {
    const decoded = decodeURIComponent(body.randsk);
    updatedCookies = `${session.cookies}; BDCLND=${decoded}`;
  }

  const updatedSession: TeraboxSessionContext = {
    ...session,
    cookies: updatedCookies,
    signData: body.sign
      ? { sign: body.sign, timestamp: body.timestamp ?? Math.floor(Date.now() / 1000) }
      : session.signData,
  };

  return { session: updatedSession, info: body };
}

export async function fetchShareList(
  session: TeraboxSessionContext,
  signal: AbortSignal,
): Promise<TeraboxShareListResponse> {
  const url = new URL('https://www.terabox.com/share/list');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('web', WEB);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('clienttype', CLIENTTYPE);
  url.searchParams.set('jsToken', session.jsToken);
  url.searchParams.set('dp-logid', session.logid);
  url.searchParams.set('page', '1');
  url.searchParams.set('num', '20');
  url.searchParams.set('by', 'name');
  url.searchParams.set('order', 'asc');
  url.searchParams.set('site_referer', '');
  url.searchParams.set('shorturl', session.shortUrl);
  url.searchParams.set('root', '1');
  if (session.signData) {
    url.searchParams.set('sign', session.signData.sign);
    url.searchParams.set('timestamp', String(session.signData.timestamp));
  }

  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/plain, */*',
      cookie: session.cookies,
      referer: `https://www.terabox.com/sharing/link?surl=${session.shortUrl}`,
    },
    signal,
  });

  const raw = await res.body.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'TeraBox share/list returned non-JSON response',
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }

  if (typeof body['errno'] === 'number' && body['errno'] === 0) {
    return body as unknown as TeraboxShareListResponse;
  }

  // TeraBox sometimes returns { code: 460020, errmsg: "need verify" } instead of errno
  if (typeof body['code'] === 'number' && body['code'] === 460020) {
    throw new ResolverError({
      code: 'PROVIDER_AUTH_EXPIRED',
      message: 'TeraBox share/list: verification required (code 460020)',
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }

  const errno = typeof body['errno'] === 'number' ? body['errno'] : -1;
  throw mapErrno(errno, 'share/list');
}

export async function fetchDownloadLink(
  session: TeraboxSessionContext,
  shareId: string | number,
  uk: string | number,
  fsId: string | number,
  signal: AbortSignal,
): Promise<TeraboxDownloadResponse> {
  const url = new URL('https://www.terabox.com/share/download');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('web', WEB);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('clienttype', CLIENTTYPE);
  url.searchParams.set('jsToken', session.jsToken);
  url.searchParams.set('dp-logid', session.logid);
  url.searchParams.set('shareid', String(shareId));
  url.searchParams.set('uk', String(uk));
  url.searchParams.set('fid_list', `[${fsId}]`);
  url.searchParams.set('primaryid', String(shareId));
  if (session.signData) {
    url.searchParams.set('sign', session.signData.sign);
    url.searchParams.set('timestamp', String(session.signData.timestamp));
  }

  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      cookie: session.cookies,
      referer: `https://www.terabox.com/sharing/link?surl=${session.shortUrl}`,
    },
    signal,
  });
  const body = (await res.body.json()) as TeraboxDownloadResponse;
  if (body.errno === 0 && body.dlink) return body;
  throw mapErrno(body.errno, 'share/download');
}

/**
 * Authenticated download: use an account pool cookie to call /share/download.
 * This returns the real full-file dlink (not a transcoded streaming segment).
 * Requires a valid TeraBox session cookie (from a logged-in account).
 */
export async function fetchAuthenticatedDownload(
  session: TeraboxSessionContext,
  shareId: string | number,
  uk: string | number,
  fsId: string | number,
  accountCookie: string,
  signal: AbortSignal,
): Promise<TeraboxDownloadResponse> {
  const url = new URL('https://www.terabox.com/share/download');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('web', WEB);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('clienttype', CLIENTTYPE);
  url.searchParams.set('jsToken', session.jsToken);
  url.searchParams.set('dp-logid', session.logid);
  url.searchParams.set('shareid', String(shareId));
  url.searchParams.set('uk', String(uk));
  url.searchParams.set('fid_list', `[${fsId}]`);
  url.searchParams.set('primaryid', String(shareId));
  if (session.signData) {
    url.searchParams.set('sign', session.signData.sign);
    url.searchParams.set('timestamp', String(session.signData.timestamp));
  }

  // Merge the account pool cookie with the session cookies
  const mergedCookies = `${session.cookies}; ${accountCookie}`;

  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      cookie: mergedCookies,
      referer: `https://www.terabox.com/sharing/link?surl=${session.shortUrl}`,
    },
    signal,
  });
  const body = (await res.body.json()) as TeraboxDownloadResponse;
  if (body.errno === 0 && body.dlink) return body;
  throw mapErrno(body.errno, 'share/download (authenticated)');
}

/**
 * Fetch an m3u8 streaming URL from /share/streaming. Returns the first
 * segment URL from the playlist which is a direct CDN link. This endpoint
 * works even when /share/download returns "need verify_v2".
 */
export async function fetchStreamingUrl(
  session: TeraboxSessionContext,
  shareId: string | number,
  uk: string | number,
  fsId: string | number,
  signal: AbortSignal,
): Promise<{ streamUrl: string; downloadUrl: string }> {
  const url = new URL('https://www.terabox.com/share/streaming');
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('web', WEB);
  url.searchParams.set('channel', CHANNEL);
  url.searchParams.set('clienttype', CLIENTTYPE);
  url.searchParams.set('uk', String(uk));
  url.searchParams.set('shareid', String(shareId));
  url.searchParams.set('fid', String(fsId));
  url.searchParams.set('type', 'M3U8_AUTO_480');
  url.searchParams.set('primaryid', String(shareId));
  if (session.signData) {
    url.searchParams.set('sign', session.signData.sign);
    url.searchParams.set('timestamp', String(session.signData.timestamp));
  }
  if (session.jsToken) {
    url.searchParams.set('jsToken', session.jsToken);
  }

  const res = await request(url, {
    method: 'GET',
    headers: {
      'user-agent': USER_AGENT,
      accept: '*/*',
      cookie: session.cookies,
      referer: `https://www.terabox.com/sharing/link?surl=${session.shortUrl}`,
    },
    signal,
  });

  const m3u8 = await res.body.text();
  const cdnMatch = /^(https?:\/\/[^\s]+)/m.exec(m3u8);
  if (!cdnMatch) {
    throw new ResolverError({
      code: 'PROVIDER_UPSTREAM_ERROR',
      message: 'TeraBox /share/streaming returned no usable CDN URL',
      provider: 'terabox',
      refundable: true,
      retriable: true,
    });
  }

  const streamUrl = cdnMatch[1] as string;
  return { streamUrl, downloadUrl: streamUrl };
}

function extractCookies(raw: string | string[] | undefined): string {
  if (!raw) return '';
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => c.split(';')[0]).join('; ');
}

function mapErrno(errno: number, endpoint: string): ResolverError {
  switch (errno) {
    case 2:
      return new ResolverError({
        code: 'CONTENT_NOT_FOUND',
        message: `TeraBox ${endpoint}: content removed (errno 2)`,
        provider: 'terabox',
        refundable: true,
        retriable: false,
      });
    case 4:
    case 112:
      return new ResolverError({
        code: 'PROVIDER_AUTH_EXPIRED',
        message: `TeraBox ${endpoint}: auth rejected (errno ${errno})`,
        provider: 'terabox',
        refundable: true,
        retriable: true,
      });
    case 105:
      return new ResolverError({
        code: 'CONTENT_PASSWORD_PROTECTED',
        message: `TeraBox ${endpoint}: password-protected link`,
        provider: 'terabox',
        refundable: true,
        retriable: false,
      });
    case -6:
    case 9019:
      return new ResolverError({
        code: 'PROVIDER_RATE_LIMITED',
        message: `TeraBox ${endpoint}: rate limited (errno ${errno})`,
        provider: 'terabox',
        refundable: true,
        retriable: true,
      });
    default:
      return new ResolverError({
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: `TeraBox ${endpoint}: upstream errno ${errno}`,
        provider: 'terabox',
        refundable: true,
        retriable: true,
      });
  }
}
