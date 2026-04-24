import { workerLatency } from '@trs/metrics';
import { buildSignedUrl } from './signing.js';
import type { RelayConfig, RelayMode } from './types.js';

/**
 * Thin client that selects a relay from the configured mesh and wraps target
 * URLs in the mode the operator chose at deploy time:
 *
 *   signed-redirect    — caller receives an HTTPS URL it can 302-to directly.
 *                        The worker validates HMAC and forwards.
 *   proxy-passthrough  — caller receives a URL shaped the same way, but the
 *                        worker streams the upstream response end-to-end.
 *
 * Selection strategy is round-robin today; add geo-routing by deploying each
 * relay URL under a regional hostname and picking via request origin.
 */
export class RelayClient {
  private idx = 0;
  constructor(private readonly cfg: RelayConfig) {}

  mode(): RelayMode {
    return this.cfg.mode;
  }

  /** Picks the next relay in a round-robin. */
  pickRelay(): string | null {
    if (this.cfg.relays.length === 0) return null;
    const relay = this.cfg.relays[this.idx % this.cfg.relays.length]!;
    this.idx++;
    return relay;
  }

  wrap(targetUrl: string): { url: string; relay: string | null; mode: RelayMode } {
    const relay = this.pickRelay();
    if (!relay) {
      // Fail-open: if the relay mesh is unconfigured (local dev), just return
      // the raw URL — the bot still works, it just loses IP diversity.
      return { url: targetUrl, relay: null, mode: this.cfg.mode };
    }
    const started = Date.now();
    const signed = buildSignedUrl(relay, targetUrl, this.cfg.secret, this.cfg.signedUrlTtlSeconds);
    workerLatency.observe({ relay, mode: this.cfg.mode }, Date.now() - started);
    return { url: signed.encoded, relay, mode: this.cfg.mode };
  }
}

export function readRelayConfigFromEnv(): RelayConfig {
  const relaysRaw = process.env.WORKER_RELAY_URLS ?? '';
  const relays = relaysRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = (process.env.RELAY_MODE as RelayMode | undefined) ?? 'signed-redirect';
  if (mode !== 'signed-redirect' && mode !== 'proxy-passthrough') {
    throw new Error(`Invalid RELAY_MODE: ${mode}`);
  }
  return {
    relays,
    secret: process.env.WORKER_RELAY_SECRET ?? '',
    mode,
    signedUrlTtlSeconds: Number(process.env.RELAY_SIGNED_URL_TTL_SECONDS ?? 900),
  };
}
