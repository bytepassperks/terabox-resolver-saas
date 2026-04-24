import { Router } from 'express';
import { z } from 'zod';
import { getPgPool, getRedisClient } from '@trs/cache-layer';
import { CreditsService } from '@trs/credits-engine';
import { TokenPool, readTokenPoolConfigFromEnv } from '@trs/bot-router';
import type { Logger } from '@trs/logger';
import { renderMetrics } from '@trs/metrics';
import { requireAdmin, type AuthedRequest } from './auth.js';

export function makeRoutes(log: Logger): Router {
  const r = Router();
  const pg = getPgPool();
  const redis = getRedisClient();
  const credits = new CreditsService({
    pg,
    log,
    resolveCost: Number(process.env.CREDIT_COST_PER_RESOLVE ?? 1),
    freeDailyCredits: Number(process.env.FREE_DAILY_CREDITS ?? 3),
  });
  const tokenPool = new TokenPool(
    TokenPool.fromEnv(process.env.TELEGRAM_BOT_TOKENS),
    redis,
    readTokenPoolConfigFromEnv(),
    log,
  );

  r.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  r.get('/metrics', async (_req, res) => {
    const m = await renderMetrics();
    res.setHeader('content-type', m.contentType);
    res.send(m.body);
  });

  r.get('/admin/users', requireAdmin('users.read'), async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const rows = await pg.query(
      `SELECT id, telegram_id, credits, plan, plan_expires_at, is_blocked, last_active_at
         FROM users ORDER BY last_active_at DESC NULLS LAST LIMIT $1`,
      [limit],
    );
    res.json({ ok: true, users: rows.rows });
  });

  r.post('/admin/block', requireAdmin('users.block'), async (req, res) => {
    const body = z.object({ userId: z.string().uuid(), reason: z.string().optional() }).parse(req.body);
    await credits.setBlocked(body.userId, true, (req as AuthedRequest).admin.sub, body.reason);
    res.json({ ok: true });
  });

  r.post('/admin/unblock', requireAdmin('users.unblock'), async (req, res) => {
    const body = z.object({ userId: z.string().uuid(), reason: z.string().optional() }).parse(req.body);
    await credits.setBlocked(body.userId, false, (req as AuthedRequest).admin.sub, body.reason);
    res.json({ ok: true });
  });

  r.post('/admin/credits/adjust', requireAdmin('credits.adjust'), async (req, res) => {
    const body = z
      .object({
        userId: z.string().uuid(),
        delta: z.number().int(),
        reason: z.string().min(1).max(240),
      })
      .parse(req.body);
    const out = await credits.grant({
      userId: body.userId,
      amount: body.delta,
      source: 'admin_adjustment',
      reason: body.reason,
      adminId: (req as AuthedRequest).admin.sub,
      idempotencyKey: `admin:${(req as AuthedRequest).admin.sub}:${body.userId}:${Date.now()}`,
    });
    res.json({ ok: true, balance: out });
  });

  r.get('/admin/stats', requireAdmin('stats.read'), async (_req, res) => {
    const [users, mutations, resolves] = await Promise.all([
      pg.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM users`),
      pg.query<{ sum: string | null }>(
        `SELECT SUM(-delta)::text AS sum FROM credit_mutations WHERE source='resolve_success'`,
      ),
      pg.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM resolve_logs`),
    ]);
    res.json({
      ok: true,
      users: Number(users.rows[0]?.count ?? 0),
      spendCredits: Number(mutations.rows[0]?.sum ?? 0),
      resolves: Number(resolves.rows[0]?.count ?? 0),
    });
  });

  r.get('/admin/cache', requireAdmin('cache.read'), async (_req, res) => {
    const dbSize = await redis.dbsize();
    res.json({ ok: true, redisKeys: dbSize });
  });

  r.post('/admin/cache-clear', requireAdmin('cache.clear'), async (_req, res) => {
    const prefix = process.env.REDIS_KEY_PREFIX ?? 'trs:';
    let cursor = '0';
    let cleared = 0;
    do {
      const r = await redis.scan(cursor, 'MATCH', `${prefix}cache:*`, 'COUNT', 500);
      cursor = r[0];
      const keys = r[1];
      if (keys.length > 0) {
        cleared += keys.length;
        await redis.del(...keys);
      }
    } while (cursor !== '0');
    res.json({ ok: true, cleared });
  });

  r.get('/admin/tokens', requireAdmin('tokens.read'), async (_req, res) => {
    const list = await tokenPool.list();
    res.json({ ok: true, tokens: list });
  });

  r.post('/admin/tokens/quarantine', requireAdmin('tokens.quarantine'), async (req, res) => {
    const body = z.object({ tokenId: z.string().min(1) }).parse(req.body);
    await tokenPool.quarantine(body.tokenId);
    res.json({ ok: true });
  });

  r.post('/admin/tokens/release', requireAdmin('tokens.quarantine'), async (req, res) => {
    const body = z.object({ tokenId: z.string().min(1) }).parse(req.body);
    await tokenPool.release(body.tokenId);
    res.json({ ok: true });
  });

  return r;
}
