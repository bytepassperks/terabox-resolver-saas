import type { Bot, Context } from 'grammy';
import { getPgPool, getRedisClient } from '@trs/cache-layer';
import type { BotContext } from '../bot.js';

/**
 * In-chat admin commands. Gated on a static allow-list from
 * ADMIN_BOOTSTRAP_TELEGRAM_IDS — for richer role management, use the JWT'd
 * admin-api service which reads the `admins` table.
 */
export function registerAdminCommands(bot: Bot, ctx: BotContext): void {
  const allow = new Set(
    (process.env.ADMIN_BOOTSTRAP_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  );
  const isAdmin = (c: Context): boolean => !!c.from?.id && allow.has(c.from.id);

  bot.command('addcredits', async (c) => {
    if (!isAdmin(c)) return;
    const [tgIdStr, amountStr] = (c.match?.toString() ?? '').split(/\s+/);
    const tgId = Number(tgIdStr);
    const amount = Number(amountStr);
    if (!tgId || !Number.isFinite(amount) || amount <= 0) {
      await c.reply('Usage: /addcredits <telegramId> <amount>');
      return;
    }
    const user = await ctx.credits.ensureUser(tgId);
    const res = await ctx.credits.grant({
      userId: user.userId,
      amount,
      source: 'admin_adjustment',
      reason: 'admin add',
      idempotencyKey: `admin-add:${tgId}:${Date.now()}`,
      adminId: String(c.from!.id),
    });
    await c.reply(`Added ${amount} credits to ${tgId}. New balance: ${res.credits}`);
  });

  bot.command('removecredits', async (c) => {
    if (!isAdmin(c)) return;
    const [tgIdStr, amountStr] = (c.match?.toString() ?? '').split(/\s+/);
    const tgId = Number(tgIdStr);
    const amount = Number(amountStr);
    if (!tgId || !Number.isFinite(amount) || amount <= 0) {
      await c.reply('Usage: /removecredits <telegramId> <amount>');
      return;
    }
    const user = await ctx.credits.ensureUser(tgId);
    const res = await ctx.credits.grant({
      userId: user.userId,
      amount: -amount,
      source: 'admin_adjustment',
      reason: 'admin remove',
      idempotencyKey: `admin-rem:${tgId}:${Date.now()}`,
      adminId: String(c.from!.id),
    });
    await c.reply(`Removed ${amount} credits from ${tgId}. New balance: ${res.credits}`);
  });

  bot.command('blockuser', async (c) => {
    if (!isAdmin(c)) return;
    const tgId = Number((c.match?.toString() ?? '').trim());
    if (!tgId) return c.reply('Usage: /blockuser <telegramId>');
    const user = await ctx.credits.ensureUser(tgId);
    await ctx.credits.setBlocked(user.userId, true, String(c.from!.id), 'bot command');
    await c.reply(`Blocked ${tgId}.`);
    return undefined;
  });

  bot.command('unblockuser', async (c) => {
    if (!isAdmin(c)) return;
    const tgId = Number((c.match?.toString() ?? '').trim());
    if (!tgId) return c.reply('Usage: /unblockuser <telegramId>');
    const user = await ctx.credits.ensureUser(tgId);
    await ctx.credits.setBlocked(user.userId, false, String(c.from!.id), 'bot command');
    await c.reply(`Unblocked ${tgId}.`);
    return undefined;
  });

  bot.command('stats', async (c) => {
    if (!isAdmin(c)) return;
    const pg = getPgPool();
    const [users, mutations, resolves] = await Promise.all([
      pg.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM users`),
      pg.query<{ sum: string | null }>(
        `SELECT SUM(delta)::text AS sum FROM credit_mutations WHERE source='resolve_success'`,
      ),
      pg.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM resolve_logs`),
    ]);
    await c.reply(
      `users=${users.rows[0]?.count ?? 0}\nresolve_spend=${mutations.rows[0]?.sum ?? 0}\nresolves=${resolves.rows[0]?.count ?? 0}`,
    );
  });

  bot.command('cacheclear', async (c) => {
    if (!isAdmin(c)) return;
    const redis = getRedisClient();
    const prefix = process.env.REDIS_KEY_PREFIX ?? 'trs:';
    let cursor = '0';
    let cleared = 0;
    do {
      const res = await redis.scan(cursor, 'MATCH', `${prefix}cache:*`, 'COUNT', 500);
      cursor = res[0];
      const keys = res[1];
      if (keys.length > 0) {
        cleared += keys.length;
        await redis.del(...keys);
      }
    } while (cursor !== '0');
    await c.reply(`Cleared ${cleared} cache entries.`);
  });

  bot.command('health', async (c) => {
    if (!isAdmin(c)) return;
    const pool = await ctx.tokenPool.list();
    const summary = pool
      .map((e) => `${e.id} ${e.tokenTail} score=${e.healthScore} q=${e.queueDepth}`)
      .join('\n');
    await c.reply(`<pre>${summary}</pre>`, { parse_mode: 'HTML' });
  });
}
