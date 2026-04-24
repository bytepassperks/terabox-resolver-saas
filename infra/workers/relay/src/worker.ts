/**
 * TRS Cloudflare relay worker.
 *
 * Two modes, switchable via the RELAY_MODE environment variable:
 *
 *   signed-redirect    — verifies HMAC, responds with 302 to the target URL.
 *                        Safe for stream URLs that are themselves long-lived
 *                        HTTPS endpoints (e.g. dlink / pixeldrain download).
 *
 *   proxy-passthrough  — verifies HMAC, streams the upstream response inline.
 *                        Gives the operator IP diversity + header masking at
 *                        the cost of bandwidth + latency.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

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
    // Strip upstream cookies to prevent accidental session leakage back to caller.
    h.delete('set-cookie');
    h.set('cache-control', 'private, max-age=0, no-store');
    return new Response(up.body, { status: up.status, headers: h });
  },
};

async function verifySig(
  secret: string,
  expiresAtMs: number,
  target: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const payload = new TextEncoder().encode(`${expiresAtMs}\n${target}`);
  const sigBytes = b64urlDecode(signature);
  if (!sigBytes) return false;
  return crypto.subtle.verify('HMAC', key, sigBytes, payload);
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
