import type { Bot, Context } from 'grammy';
import { ResolverError } from '@trs/shared-types';
import { PAID_PLAN_IDS, PLAN_DEFINITIONS } from '@trs/credits-engine';
import type { BotContext } from '../bot.js';
import { renderError, renderSuccess } from '../ui.js';

const HELP_TEXT = [
  '<b>TeraBox Resolver SaaS</b>',
  '',
  'Send me any supported share link — I will return a playable / downloadable URL.',
  '',
  '<b>Commands</b>',
  '/start  — intro',
  '/help   — this message',
  '/balance — show your credit balance',
  '/plan   — show your current plan',
  '/buy    — purchase credits with Telegram Stars',
  '/redeem &lt;code&gt; — redeem a promo code',
  '/resolve &lt;url&gt; — resolve a share link',
].join('\n');

export function registerUserCommands(bot: Bot, ctx: BotContext): void {
  bot.command('start', async (c) => {
    await ensureUser(c, ctx);
    await c.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('help', (c) => c.reply(HELP_TEXT, { parse_mode: 'HTML' }));

  bot.command('balance', async (c) => {
    const user = await ensureUser(c, ctx);
    await c.reply(
      `💰 Balance: <b>${user.credits}</b> credits\nPlan: <b>${user.plan}</b>` +
        (user.planExpiresAtMs
          ? `\nExpires: <i>${new Date(user.planExpiresAtMs).toISOString().slice(0, 10)}</i>`
          : ''),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('plan', async (c) => {
    const user = await ensureUser(c, ctx);
    const def = PLAN_DEFINITIONS[user.plan];
    await c.reply(
      `<b>${def.name}</b>\nCredits on grant: ${def.credits}\nRate tier: ${def.rateTier}\nValidity: ${def.validityDays ?? '∞'} days`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('buy', async (c) => {
    const rows = PAID_PLAN_IDS.map((id) => {
      const p = PLAN_DEFINITIONS[id];
      return [{ text: `${p.name} — ${p.credits} cr (${p.stars}⭐)`, callback_data: `buy:${id}` }];
    });
    await c.reply('Choose a plan to purchase with Telegram Stars:', {
      reply_markup: { inline_keyboard: rows },
    });
  });

  bot.command('redeem', async (c) => {
    await c.reply(
      'Redeem codes are coming soon. Your admin can grant bonuses via /addcredits.',
    );
  });

  // Free-form URL → resolve.
  bot.on('message:text', async (c) => {
    const text = c.message.text.trim();
    if (!/^https?:\/\//i.test(text)) return;
    await handleResolve(c, ctx, text);
  });

  bot.command('resolve', async (c) => {
    const arg = c.match?.toString().trim() ?? '';
    if (!arg) {
      await c.reply('Usage: /resolve <url>');
      return;
    }
    await handleResolve(c, ctx, arg);
  });
}

async function ensureUser(c: Context, ctx: BotContext) {
  const tgId = c.from?.id;
  if (!tgId) throw new Error('Missing sender');
  return ctx.credits.ensureUser(tgId);
}

async function handleResolve(c: Context, ctx: BotContext, url: string): Promise<void> {
  const tgId = c.from?.id;
  if (!tgId) return;
  const user = await ensureUser(c, ctx);

  if (user.isBlocked) {
    await c.reply(renderError('BLOCKED', 'Your account is blocked. Contact support.'), {
      parse_mode: 'HTML',
    });
    return;
  }
  if (user.credits <= 0) {
    await c.reply('You have no credits left. Use /buy to top up.');
    return;
  }

  const tier = user.plan === 'free' ? 'free' : user.plan === 'ultra' || user.plan === 'power' || user.plan === 'pro' ? 'premium' : 'paid';
  const rate = await ctx.rateLimiter.checkUser(tgId, tier);
  if (!rate.allowed) {
    await c.reply(`⏱ Slow down — try again in ~${rate.retryAfterSeconds}s`);
    return;
  }

  const abuse = await ctx.abuse.evaluate(tgId, url);
  if (abuse.block) {
    ctx.log.warn({ tgId, signals: abuse.signals }, 'telegram-bot: abuse block');
    await c.reply('Too many automated requests detected. Please slow down.');
    return;
  }
  if (abuse.shadowThrottle) {
    await new Promise((r) => setTimeout(r, 2500));
  }

  const pending = await c.reply('🔎 Resolving…');
  const requestId = `tg-${tgId}-${Date.now()}`;
  try {
    const result = await ctx.resolver.resolve({ url, telegramUserId: tgId, requestId });

    // Charge only AFTER resolver-api returns success.
    const charged = await ctx.credits.charge({
      userId: user.userId,
      idempotencyKey: `resolve:${requestId}`,
      source: 'resolve_success',
      reason: 'resolve success',
      metadata: { provider: result.provider, shareId: result.shareId },
    });

    const msg = renderSuccess(result, charged.credits);
    if (result.thumbnailUrl) {
      await c.replyWithPhoto(result.thumbnailUrl, {
        caption: msg.text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: msg.inlineKeyboard },
      });
    } else {
      await c.reply(msg.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: msg.inlineKeyboard },
      });
    }
    await c.api.deleteMessage(c.chat!.id, pending.message_id).catch(() => undefined);
  } catch (err) {
    await c.api.deleteMessage(c.chat!.id, pending.message_id).catch(() => undefined);
    if (ResolverError.is(err)) {
      await c.reply(renderError(err.code, err.message), { parse_mode: 'HTML' });
      return;
    }
    ctx.log.error({ err, tgId }, 'telegram-bot: resolve failed');
    await c.reply('Something went wrong while resolving. Please try again.');
  }
}
