export type RelayMode = 'signed-redirect' | 'proxy-passthrough';

export interface RelayConfig {
  relays: string[];
  secret: string;
  mode: RelayMode;
  signedUrlTtlSeconds: number;
}
