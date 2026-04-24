/**
 * Canonical set of share-link providers the resolver understands.
 * Adapter modules register themselves against these IDs so the gateway
 * stays provider-agnostic.
 */
export const PROVIDER_IDS = [
  'terabox',
  'gofile',
  'pixeldrain',
  'buzzheavier',
  // reserved for future adapters — inactive stubs are fine on day one
  'drive',
  'dropbox',
  'onedrive',
  'mediafire',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderCapabilities {
  /** Whether the adapter can currently produce a working response. */
  active: boolean;
  /** Whether the adapter supports direct stream URLs (.m3u8 / mp4). */
  supportsStream: boolean;
  /** Whether the adapter supports direct download URLs. */
  supportsDownload: boolean;
  /** Whether the adapter can produce a thumbnail URL. */
  supportsThumbnail: boolean;
}
