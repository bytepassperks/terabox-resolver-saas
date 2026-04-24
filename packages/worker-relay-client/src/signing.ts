import { createHmac } from 'node:crypto';

/**
 * HMAC-SHA256 signed URL payload. The Cloudflare worker uses the identical
 * algorithm to verify incoming requests — keep these two files in lockstep.
 *
 *   sig = HMAC_SHA256(secret, `${expiresAt}\n${targetUrl}`)
 *
 * The URL the worker receives is:
 *   https://relay/?u=<base64url(target)>&e=<expiresAt>&s=<base64url(sig)>
 */
export interface SignedRelayUrl {
  relayBase: string;
  targetUrl: string;
  expiresAtMs: number;
  encoded: string;
}

export function buildSignedUrl(
  relayBase: string,
  targetUrl: string,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): SignedRelayUrl {
  const expiresAtMs = now + ttlSeconds * 1000;
  const payload = `${expiresAtMs}\n${targetUrl}`;
  const sig = createHmac('sha256', secret).update(payload).digest();
  const params = new URLSearchParams({
    u: b64url(Buffer.from(targetUrl, 'utf8')),
    e: String(expiresAtMs),
    s: b64url(sig),
  });
  const base = relayBase.replace(/\/$/, '');
  return {
    relayBase: base,
    targetUrl,
    expiresAtMs,
    encoded: `${base}/?${params.toString()}`,
  };
}

export function verifySignedUrl(
  encodedTarget: string,
  expiresAtMs: number,
  sig: string,
  secret: string,
  now = Date.now(),
): { ok: boolean; targetUrl?: string; reason?: string } {
  if (now > expiresAtMs) return { ok: false, reason: 'expired' };
  let targetUrl: string;
  try {
    targetUrl = Buffer.from(b64urlDecode(encodedTarget), 'base64').toString('utf8');
  } catch {
    return { ok: false, reason: 'malformed_target' };
  }
  const payload = `${expiresAtMs}\n${targetUrl}`;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const got = Buffer.from(b64urlDecode(sig), 'base64');
  if (expected.length !== got.length || !timingSafeEq(expected, got)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, targetUrl };
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return (input + pad).replace(/-/g, '+').replace(/_/g, '/');
}

function timingSafeEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i]! ^ b[i]!;
  return out === 0;
}
