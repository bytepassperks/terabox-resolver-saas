export interface ResolverCoreConfig {
  timeoutMs: number;
  failureThreshold: number;
  retryWindowMs: number;
  /** Namespace prefix (shared with cache-layer). */
  keyPrefix: string;
}

export function readResolverCoreConfigFromEnv(): ResolverCoreConfig {
  return {
    timeoutMs: Number(process.env.RESOLVER_TIMEOUT_MS ?? 15000),
    failureThreshold: Number(process.env.RESOLVER_FAILURE_THRESHOLD ?? 5),
    retryWindowMs: Number(process.env.RESOLVER_RETRY_WINDOW_MS ?? 60000),
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'trs:',
  };
}
