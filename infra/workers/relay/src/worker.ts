/**
 * TRS Cloudflare relay worker.
 *
 * Modes / routes:
 *
 *   GET /health          — health check
 *
 *   GET /?u=&e=&s=       — original relay (signed-redirect or proxy-passthrough)
 *
 *   POST /resolve        — TeraBox API resolver. Runs the full extraction flow
 *                          from CF edge so that share/list + share/download
 *                          succeed (datacenter IPs get "need verify_v2").
 *                          Request body is HMAC-signed JSON.
 *
 * Shared HMAC signing format (identical to packages/worker-relay-client):
 *   sig = HMAC_SHA256(secret, `${expiresAt}\n${targetUrl}`)
 *   URL = https://<worker-host>/?u=<b64url(target)>&e=<expiresAtMs>&s=<b64url(sig)>
 */
export interface Env {
  RELAY_MODE: 'signed-redirect' | 'proxy-passthrough';
  WORKER_RELAY_SECRET: string;
}

const USER_AGENT_MASK =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const APP_ID = '250528';
const CLIENTTYPE = '0';
const WEB = '1';
const CHANNEL = 'dubox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return new Response('ok');

    // ── POST /resolve — TeraBox API resolver from CF edge ──
    if (url.pathname === '/resolve' && request.method === 'POST') {
      return handleResolve(request, env);
    }

    // ── Original relay mode ──
    const u = url.searchParams.get('u');
    const e = url.searchParams.get('e');
    const s = url.searchParams.get('s');
    if (!u || !e || !s) return new Response('missing params', { status: 400 });

    const expiresAtMs = Number(e);
    if (!Number.isFinite(expiresAtMs)) return new Response('bad expiry', { status: 400 });
    if (Date.now() > expiresAtMs) return new Response('expired', { status: 410 });

    const targetUrl = b64urlDecodeString(u);
    if (!targetUrl) return new Response('bad target', { status: 400 });

    const ok = await verifySig(env.WORKER_RELAY_SECRET, expiresAtMs, targetUrl, s);
    if (!ok) return new Response('bad signature', { status: 403 });

    const mode = env.RELAY_MODE ?? 'signed-redirect';
    if (mode === 'signed-redirect') {
      return Response.redirect(targetUrl, 302);
    }

    // Proxy passthrough: forward with masked headers and stream the body.
    const upstream = new URL(targetUrl);
    const req = new Request(upstream, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT_MASK,
        accept: '*/*',
        referer: upstream.origin,
      },
      redirect: 'follow',
    });
    const up = await fetch(req);
    const h = new Headers(up.headers);
    h.delete('set-cookie');
    h.set('cache-control', 'private, max-age=0, no-store');
    return new Response(up.body, { status: up.status, headers: h });
  },
};

// ─── /resolve handler ────────────────────────────────────────────────────────

interface ResolveRequest {
  shortUrl: string;
  cookie: string;
  password?: string;
  /** HMAC fields for authentication */
  expires: number;
  sig: string;
}

interface ResolveResult {
  errno: number;
  shareid?: number;
  uk?: number;
  sign?: string;
  timestamp?: number;
  files?: Array<{
    fs_id: number;
    server_filename: string;
    size: number;
    isdir: number;
    category: number;
    path: string;
    md5?: string;
    dlink?: string;
    thumbs?: Record<string, string>;
  }>;
  dlink?: string;
  errmsg?: string;
}

async function handleResolve(request: Request, env: Env): Promise<Response> {
  let body: ResolveRequest;
  try {
    body = await request.json() as ResolveRequest;
  } catch {
    return jsonResponse({ errno: -1, errmsg: 'invalid JSON body' }, 400);
  }

  const { shortUrl, cookie, password, expires, sig } = body;
  if (!shortUrl || !cookie || !expires || !sig) {
    return jsonResponse({ errno: -1, errmsg: 'missing required fields' }, 400);
  }

  // Verify HMAC: sig = HMAC_SHA256(secret, `${expires}\nresolve:${shortUrl}`)
  const payload = `${expires}\nresolve:${shortUrl}`;
  const ok = await verifySigRaw(env.WORKER_RELAY_SECRET, payload, sig);
  if (!ok) return jsonResponse({ errno: -1, errmsg: 'bad signature' }, 403);
  if (Date.now() > expires) return jsonResponse({ errno: -1, errmsg: 'expired' }, 410);

  try {
    const result = await resolveTerabox(shortUrl, cookie, password);
    return jsonResponse(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ errno: -1, errmsg: msg }, 500);
  }
}

async function resolveTerabox(
  shortUrl: string,
  accountCookie: string,
  password?: string,
): Promise<ResolveResult> {
  // Step 1: Fetch sharing page to get jsToken + session cookies
  const pageUrl = `https://www.terabox.com/sharing/link?surl=${encodeURIComponent(shortUrl)}`;
  const pageRes = await fetch(pageUrl, {
    headers: {
      'user-agent': USER_AGENT_MASK,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      cookie: accountCookie,
    },
    redirect: 'follow',
  });

  const html = await pageRes.text();
  const jsTokenMatch = /fn%28%22([A-Za-z0-9]+)%22%29/.exec(html);
  const logidMatch = /dp-logid=([A-Za-z0-9]+)/.exec(html);
  const jsToken = jsTokenMatch?.[1];
  const logid = logidMatch?.[1] ?? '';

  if (!jsToken) {
    return { errno: -1, errmsg: 'Could not extract jsToken from sharing page' };
  }

  // Merge page set-cookie with account cookie (account auth cookies take priority)
  const setCookieHeaders = pageRes.headers.getAll?.('set-cookie') ?? [];
  const pageCookies = parseCookieHeaders(setCookieHeaders);
  const acctCookies = parseCookieString(accountCookie);
  const AUTH_KEYS = ['ndut_fmt', 'ndut_fmv', 'ndus', 'ab_sr', 'browserid'];
  const merged: Record<string, string> = { ...pageCookies };
  for (const k of AUTH_KEYS) {
    if (acctCookies[k]) merged[k] = acctCookies[k]!;
  }
  let cookies = cookieObjToString(merged);

  // Step 2: shorturlinfo — get file metadata + sign + BDCLND
  const infoUrl = new URL('https://www.terabox.com/api/shorturlinfo');
  infoUrl.searchParams.set('app_id', APP_ID);
  infoUrl.searchParams.set('web', WEB);
  infoUrl.searchParams.set('channel', CHANNEL);
  infoUrl.searchParams.set('clienttype', CLIENTTYPE);
  infoUrl.searchParams.set('shorturl', shortUrl);
  infoUrl.searchParams.set('root', '1');

  const infoRes = await fetch(infoUrl.toString(), {
    headers: {
      'user-agent': USER_AGENT_MASK,
      accept: 'application/json',
      cookie: cookies,
      referer: pageUrl,
    },
  });
  const info = await infoRes.json() as Record<string, unknown>;

  if ((info as { errno?: number }).errno !== 0) {
    return { errno: (info as { errno?: number }).errno ?? -1, errmsg: `shorturlinfo error` };
  }

  const shareid = info['shareid'] as number;
  const uk = info['uk'] as number;
  const sign = info['sign'] as string | undefined;
  const timestamp = info['timestamp'] as number | undefined;
  const randsk = info['randsk'] as string | undefined;
  const files = (info['list'] as Array<Record<string, unknown>>) ?? [];

  if (!shareid || !uk || files.length === 0) {
    return { errno: -1, errmsg: 'shorturlinfo: missing shareid/uk/files' };
  }

  // Add BDCLND from randsk
  if (randsk) {
    cookies += `; BDCLND=${decodeURIComponent(randsk)}`;
  }

  // Step 3: If password-protected, verify password
  if (password) {
    const verifyUrl = new URL('https://www.terabox.com/share/verify');
    verifyUrl.searchParams.set('app_id', APP_ID);
    verifyUrl.searchParams.set('web', WEB);
    verifyUrl.searchParams.set('channel', CHANNEL);
    verifyUrl.searchParams.set('clienttype', CLIENTTYPE);
    verifyUrl.searchParams.set('jsToken', jsToken);
    verifyUrl.searchParams.set('dp-logid', logid);
    verifyUrl.searchParams.set('shorturl', shortUrl);

    const verifyRes = await fetch(verifyUrl.toString(), {
      method: 'POST',
      headers: {
        'user-agent': USER_AGENT_MASK,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies,
        referer: pageUrl,
      },
      body: `pwd=${encodeURIComponent(password)}`,
    });
    const verifyBody = await verifyRes.json() as Record<string, unknown>;
    if ((verifyBody as { errno?: number }).errno !== 0) {
      return { errno: 105, errmsg: 'password verification failed' };
    }
    // Merge verify cookies
    const verifyCookies = parseCookieHeaders(verifyRes.headers.getAll?.('set-cookie') ?? []);
    Object.assign(merged, verifyCookies);
    cookies = cookieObjToString(merged);
  }

  // Step 4: share/list — returns file dlink
  const listUrl = new URL('https://www.terabox.com/share/list');
  listUrl.searchParams.set('app_id', APP_ID);
  listUrl.searchParams.set('web', WEB);
  listUrl.searchParams.set('channel', CHANNEL);
  listUrl.searchParams.set('clienttype', CLIENTTYPE);
  listUrl.searchParams.set('jsToken', jsToken);
  listUrl.searchParams.set('dp-logid', logid);
  listUrl.searchParams.set('page', '1');
  listUrl.searchParams.set('num', '20');
  listUrl.searchParams.set('by', 'name');
  listUrl.searchParams.set('order', 'asc');
  listUrl.searchParams.set('shorturl', shortUrl);
  listUrl.searchParams.set('root', '1');
  if (sign) listUrl.searchParams.set('sign', sign);
  if (timestamp) listUrl.searchParams.set('timestamp', String(timestamp));

  const listRes = await fetch(listUrl.toString(), {
    headers: {
      'user-agent': USER_AGENT_MASK,
      accept: 'application/json',
      cookie: cookies,
      referer: pageUrl,
    },
  });
  const listBody = await listRes.json() as Record<string, unknown>;
  const listErrno = (listBody as { errno?: number }).errno;

  let resultFiles: ResolveResult['files'] = [];
  let mainDlink: string | undefined;

  if (listErrno === 0 && Array.isArray(listBody['list'])) {
    resultFiles = (listBody['list'] as Array<Record<string, unknown>>).map((f) => ({
      fs_id: Number(f['fs_id']),
      server_filename: String(f['server_filename'] ?? ''),
      size: Number(f['size'] ?? 0),
      isdir: Number(f['isdir'] ?? 0),
      category: Number(f['category'] ?? 0),
      path: String(f['path'] ?? ''),
      md5: f['md5'] as string | undefined,
      dlink: f['dlink'] as string | undefined,
      thumbs: f['thumbs'] as Record<string, string> | undefined,
    }));
    mainDlink = resultFiles[0]?.dlink;
  }

  // Step 5: If share/list didn't give dlink, try share/download
  if (!mainDlink && files[0]) {
    const firstFile = files[0]!;
    const dlUrl = new URL('https://www.terabox.com/share/download');
    dlUrl.searchParams.set('app_id', APP_ID);
    dlUrl.searchParams.set('web', WEB);
    dlUrl.searchParams.set('channel', CHANNEL);
    dlUrl.searchParams.set('clienttype', CLIENTTYPE);
    dlUrl.searchParams.set('jsToken', jsToken);
    dlUrl.searchParams.set('dp-logid', logid);
    dlUrl.searchParams.set('shareid', String(shareid));
    dlUrl.searchParams.set('uk', String(uk));
    dlUrl.searchParams.set('fid_list', `[${firstFile['fs_id']}]`);
    dlUrl.searchParams.set('primaryid', String(shareid));
    if (sign) dlUrl.searchParams.set('sign', sign);
    if (timestamp) dlUrl.searchParams.set('timestamp', String(timestamp));

    const dlRes = await fetch(dlUrl.toString(), {
      headers: {
        'user-agent': USER_AGENT_MASK,
        accept: 'application/json',
        cookie: cookies,
        referer: pageUrl,
      },
    });
    const dlBody = await dlRes.json() as Record<string, unknown>;
    if ((dlBody as { errno?: number }).errno === 0 && dlBody['dlink']) {
      mainDlink = String(dlBody['dlink']);
    }
  }

  // Step 6: If still no dlink, try streaming as fallback data
  if (!mainDlink && files[0]) {
    const firstFile = files[0]!;
    const streamUrl = new URL('https://www.terabox.com/share/streaming');
    streamUrl.searchParams.set('app_id', APP_ID);
    streamUrl.searchParams.set('web', WEB);
    streamUrl.searchParams.set('channel', CHANNEL);
    streamUrl.searchParams.set('clienttype', CLIENTTYPE);
    streamUrl.searchParams.set('uk', String(uk));
    streamUrl.searchParams.set('shareid', String(shareid));
    streamUrl.searchParams.set('fid', String(firstFile['fs_id']));
    streamUrl.searchParams.set('type', 'M3U8_AUTO_480');
    streamUrl.searchParams.set('primaryid', String(shareid));
    if (sign) streamUrl.searchParams.set('sign', sign);
    if (timestamp) streamUrl.searchParams.set('timestamp', String(timestamp));
    if (jsToken) streamUrl.searchParams.set('jsToken', jsToken);

    const streamRes = await fetch(streamUrl.toString(), {
      headers: {
        'user-agent': USER_AGENT_MASK,
        accept: '*/*',
        cookie: cookies,
        referer: pageUrl,
      },
    });
    const m3u8 = await streamRes.text();
    const cdnMatch = /^(https?:\/\/[^\s]+)/m.exec(m3u8);
    if (cdnMatch) {
      mainDlink = cdnMatch[1];
    }
  }

  // Use shorturlinfo file data if share/list didn't return files
  if (resultFiles.length === 0) {
    resultFiles = files.map((f) => ({
      fs_id: Number(f['fs_id']),
      server_filename: String(f['server_filename'] ?? ''),
      size: Number(f['size'] ?? 0),
      isdir: Number(f['isdir'] ?? 0),
      category: Number(f['category'] ?? 0),
      path: String(f['path'] ?? ''),
      md5: f['md5'] as string | undefined,
      dlink: mainDlink,
      thumbs: f['thumbs'] as Record<string, string> | undefined,
    }));
  }

  return {
    errno: 0,
    shareid,
    uk,
    sign,
    timestamp,
    files: resultFiles,
    dlink: mainDlink,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function parseCookieHeaders(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    const part = h.split(';')[0];
    if (part) {
      const idx = part.indexOf('=');
      if (idx > 0) result[part.substring(0, idx).trim()] = part.substring(idx + 1);
    }
  }
  return result;
}

function parseCookieString(str: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of str.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) result[trimmed.substring(0, idx)] = trimmed.substring(idx + 1);
  }
  return result;
}

function cookieObjToString(obj: Record<string, string>): string {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function verifySig(
  secret: string,
  expiresAtMs: number,
  target: string,
  signature: string,
): Promise<boolean> {
  const payload = `${expiresAtMs}\n${target}`;
  return verifySigRaw(secret, payload, signature);
}

async function verifySigRaw(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const payloadBytes = new TextEncoder().encode(payload);
  const sigBytes = b64urlDecode(signature);
  if (!sigBytes) return false;
  return crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
}

function b64urlDecode(input: string): Uint8Array | null {
  try {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64urlDecodeString(input: string): string | null {
  const bytes = b64urlDecode(input);
  if (!bytes) return null;
  return new TextDecoder().decode(bytes);
}
