import { Redis, type RedisOptions } from 'ioredis';

export type RedisClient = Redis;

let sharedClient: Redis | null = null;

export function getRedisClient(url = process.env.REDIS_URL): Redis {
  if (sharedClient) return sharedClient;
  if (!url) throw new Error('REDIS_URL is required to initialize the cache layer.');
  const options: RedisOptions = {
    lazyConnect: false,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 3,
    // Reconnect with light backoff so transient blips don't cascade.
    retryStrategy: (times) => Math.min(times * 200, 3000),
  };
  sharedClient = new Redis(url, options);
  return sharedClient;
}

export async function closeRedisClient(): Promise<void> {
  if (sharedClient) {
    await sharedClient.quit();
    sharedClient = null;
  }
}
