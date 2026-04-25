import { Pool, type PoolConfig } from 'pg';

let sharedPool: Pool | null = null;

export function getPgPool(url = process.env.DATABASE_URL): Pool {
  if (sharedPool) return sharedPool;
  if (!url) throw new Error('DATABASE_URL is required.');
  const config: PoolConfig = {
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  if (process.env.DATABASE_SSL === 'true') {
    config.ssl = { rejectUnauthorized: false };
  }
  sharedPool = new Pool(config);
  return sharedPool;
}

export async function closePgPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}
