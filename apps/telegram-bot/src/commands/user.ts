import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import { request as undiciRequest } from 'undici';
import { ResolverError } from '@trs/shared-types';
import { PLAN_DEFINITIONS } from '@trs/credits-engine';
import type { BotContext } from '../bot.js';
import {
  escapeHtml,
  lookupCopyUrl,
  renderBalance,
  renderBlocked,
  renderBuy,
  renderErrorWithButtons,
  renderHelp,
  renderHistory,
  renderLowCredits,
  renderNoCredits,
  renderPasswordInvalid,
  renderPasswordRequired,
  renderPasswordVerifying,
  renderResolvePending,
  renderResolveStillWorking,
  renderStart,
  renderSuccess,
} from '../ui.js';

const PENDING_PASSWORD_TTL_MS = 5 * 60 * 1000;

interface PendingPasswordSession {
  url: string;
  requestId: string;
  expiresAt: number;
}

const pendingPasswords = new Map<number, PendingPasswordSession>();

export function registerUserCommands(bot: Bot, ctx: BotContext): void {
  // ── /start ──────────────────────────────────────────────────────
  bot.command('start', async (c) => {
    const user = await ensureUser(c, ctx);
    const msg = renderStart(user.credits);
    await c.reply(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    });
  });

  // ── /help ───────────────────────────────────────────────────────
  bot.command('help', async (c) => {
    const msg = renderHelp();
    await c.reply(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    });
  });

  // ── /balance ────────────────────────────────────────────────────
  bot.command('balance', async (c) => {
    const user = await ensureUser(c, ctx);
    const msg = renderBalance(user.credits, user.plan);
    await c.reply(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    });
  });

  // ── /plan ───────────────────────────────────────────────────────
  bot.command('plan', async (c) => {
    const user = await ensureUser(c, ctx);
    const def = PLAN_DEFINITIONS[user.plan];
    await c.reply(
      `<b>${def.name}</b>\nCredits on grant: ${def.credits}\nRate tier: ${def.rateTier}\nValidity: ${def.validityDays ?? '\u221E'} days`,
      { parse_mode: 'HTML' },
    );
  });

  // ── /buy ────────────────────────────────────────────────────────
  bot.command('buy', async (c) => {
    const msg = renderBuy();
    await c.reply(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    });
  });

  // ── /redeem ─────────────────────────────────────────────────────
  bot.command('redeem', async (c) => {
    await c.reply(
      'Redeem codes are coming soon. Your admin can grant bonuses via /addcredits.',
    );
  });

  // ── /history ────────────────────────────────────────────────────
  bot.command('history', async (c) => {
    await c.reply(renderHistory(), { parse_mode: 'HTML' });
  });

  // ── Inline button callbacks for navigation ──────────────────────
  bot.callbackQuery('action:start', async (c) => {
    await c.answerCallbackQuery();
    const user = await ensureUser(c, ctx);
    const msg = renderStart(user.credits);
    await c.editMessageText(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    }).catch(() => undefined);
  });

  bot.callbackQuery('action:help', async (c) => {
    await c.answerCallbackQuery();
    const msg = renderHelp();
    await c.editMessageText(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    }).catch(() => undefined);
  });

  bot.callbackQuery('action:balance', async (c) => {
    await c.answerCallbackQuery();
    const user = await ensureUser(c, ctx);
    const msg = renderBalance(user.credits, user.plan);
    await c.editMessageText(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    }).catch(() => undefined);
  });

  bot.callbackQuery('action:buy', async (c) => {
    await c.answerCallbackQuery();
    const msg = renderBuy();
    await c.editMessageText(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    }).catch(() => undefined);
  });

  bot.callbackQuery('action:resolve', async (c) => {
    await c.answerCallbackQuery();
    await c.editMessageText('\u{1F50D} Send me a share link to resolve.', {
      parse_mode: 'HTML',
    }).catch(() => undefined);
  });

  bot.callbackQuery('action:redeem', async (c) => {
    await c.answerCallbackQuery();
    await c.editMessageText(
      'Redeem codes are coming soon. Your admin can grant bonuses via /addcredits.',
    ).catch(() => undefined);
  });

  // ── Copy Link callback — send the download URL as a copyable message ─
  bot.callbackQuery(/^copy:/, async (c) => {
    const copyId = c.callbackQuery.data.replace('copy:', '');
    const url = lookupCopyUrl(copyId);
    if (!url) {
      await c.answerCallbackQuery({ text: 'Link expired — resolve again', show_alert: true });
      return;
    }
    await c.answerCallbackQuery({ text: 'Link sent below \u2193' });
    await c.reply(`<code>${escapeHtml(url)}</code>`, { parse_mode: 'HTML' });
  });

  // ── /resolve command ────────────────────────────────────────────
  bot.command('resolve', async (c) => {
    const arg = c.match?.toString().trim() ?? '';
    if (!arg) {
      await c.reply('Usage: /resolve <url>');
      return;
    }
    await handleResolve(c, ctx, arg);
  });

  // ── Free-form URL → resolve ─────────────────────────────────────
  bot.on('message:text', async (c) => {
    const text = c.message.text.trim();
    const tgId = c.from?.id;

    // Check if this is a password reply for a pending session
    if (tgId && pendingPasswords.has(tgId)) {
      const session = pendingPasswords.get(tgId)!;
      if (Date.now() < session.expiresAt) {
        pendingPasswords.delete(tgId);
        await handleResolveWithPassword(c, ctx, session.url, text, session.requestId);
        return;
      }
      pendingPasswords.delete(tgId);
    }

    if (!/^https?:\/\//i.test(text)) return;
    await handleResolve(c, ctx, text);
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
    await c.reply(renderBlocked(), { parse_mode: 'HTML' });
    return;
  }
  if (user.credits <= 0) {
    const msg = renderNoCredits();
    await c.reply(msg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: msg.inlineKeyboard },
    });
    return;
  }

  const tier = user.plan === 'free' ? 'free' : user.plan === 'ultra' || user.plan === 'power' || user.plan === 'pro' ? 'premium' : 'paid';
  const rate = await ctx.rateLimiter.checkUser(tgId, tier);
  if (!rate.allowed) {
    await c.reply(`\u23F1 Slow down \u2014 try again in ~${rate.retryAfterSeconds}s`);
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

  const pending = await c.reply(renderResolvePending(), { parse_mode: 'HTML' });
  const requestId = `tg-${tgId}-${Date.now()}`;

  const stillWorkingTimer = setTimeout(async () => {
    try {
      await c.api.editMessageText(c.chat!.id, pending.message_id, renderResolveStillWorking(), {
        parse_mode: 'HTML',
      });
    } catch { /* ignore */ }
  }, 2000);

  try {
    const result = await ctx.resolver.resolve({ url, telegramUserId: tgId, requestId });

    clearTimeout(stillWorkingTimer);

    if (result.requiresPassword) {
      await c.api.deleteMessage(c.chat!.id, pending.message_id).catch(() => undefined);
      pendingPasswords.set(tgId, { url, requestId, expiresAt: Date.now() + PENDING_PASSWORD_TTL_MS });
      await c.reply(renderPasswordRequired(), { parse_mode: 'HTML' });
      return;
    }

    // Build the success message FIRST so that if the Telegram send fails
    // (e.g. BUTTON_DATA_INVALID) we don't consume credits.
    const previewMsg = renderSuccess(result, user.credits - 1);
    const isVideo = result.mimeType?.startsWith('video/');

    let sent = false;

    // For videos, download through relay and send as native Telegram video.
    if (isVideo && result.downloadUrl) {
      try {
        const videoResp = await undiciRequest(result.downloadUrl, {
          method: 'GET',
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        } as Parameters<typeof undiciRequest>[1]);
        const chunks: Buffer[] = [];
        for await (const chunk of videoResp.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const videoBuffer = Buffer.concat(chunks);
        if (videoBuffer.length > 1024) {
          const fileName = result.fileName || 'video.mp4';
          await c.replyWithVideo(new InputFile(videoBuffer, fileName), {
            caption: previewMsg.text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: previewMsg.inlineKeyboard },
            supports_streaming: true,
          });
          sent = true;
        }
      } catch {
        // Download or send failed — fall through to text
      }
    }

    // For non-video results, try sending with thumbnail photo.
    if (!sent && result.thumbnailUrl) {
      try {
        await c.replyWithPhoto(result.thumbnailUrl, {
          caption: previewMsg.text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: previewMsg.inlineKeyboard },
        });
        sent = true;
      } catch {
        // Telegram couldn't fetch the thumbnail — fall through to text
      }
    }

    // Fallback: plain text message (always works).
    if (!sent) {
      await c.reply(previewMsg.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: previewMsg.inlineKeyboard },
      });
    }
    await c.api.deleteMessage(c.chat!.id, pending.message_id).catch(() => undefined);

    // Message sent successfully — now charge credits
    const charged = await ctx.credits.charge({
      userId: user.userId,
      idempotencyKey: `resolve:${requestId}`,
      source: 'resolve_success',
      reason: 'resolve success',
      metadata: { provider: result.provider, shareId: result.shareId },
    });

    if (charged.credits <= 2 && charged.credits > 0) {
      await c.reply(renderLowCredits(charged.credits), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '\u2B50 Buy Credits', callback_data: 'action:buy' }]],
        },
      });
    }
  } catch (err) {
    clearTimeout(stillWorkingTimer);
    await c.api.deleteMessage(c.chat!.id, pending.message_id).catch(() => undefined);
    if (ResolverError.is(err)) {
      if (err.code === 'CONTENT_PASSWORD_PROTECTED') {
        pendingPasswords.set(tgId, { url, requestId, expiresAt: Date.now() + PENDING_PASSWORD_TTL_MS });
        await c.reply(renderPasswordRequired(), { parse_mode: 'HTML' });
        return;
      }
      const errMsg = renderErrorWithButtons(err.code, err.message, url);
      await c.reply(errMsg.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: errMsg.inlineKeyboard },
      });
      return;
    }
    ctx.log.error({ err, tgId }, 'telegram-bot: resolve failed');
    const errMsg = renderErrorWithButtons('INTERNAL_ERROR', 'Something went wrong', url);
    await c.reply(errMsg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: errMsg.inlineKeyboard },
    });
  }
}

async function handleResolveWithPassword(
  c: Context,
  ctx: BotContext,
  url: string,
  password: string,
  requestId: string,
): Promise<void> {
  const tgId = c.from?.id;
  if (!tgId) return;
  const user = await ensureUser(c, ctx);

  const pending = await c.reply(renderPasswordVerifying(), { parse_mode: 'HTML' });

  try {
    const result = await ctx.resolver.resolve({ url, telegramUserId: tgId, requestId, password });

    const charged = await ctx.credits.charge({
      userId: user.userId,
      idempotencyKey: `resolve:${requestId}`,
      source: 'resolve_success',
      reason: 'resolve success (password unlock)',
      metadata: { provider: result.provider, shareId: result.shareId, unlocked: true },
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

    if (charged.credits <= 2 && charged.credits > 0) {
      await c.reply(renderLowCredits(charged.credits), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '\u2B50 Buy Credits', callback_data: 'action:buy' }]],
        },
      });
    }
  } catch (err) {
    await c.api.deleteMessage(c.chat!.id, pending.message_id).catch(() => undefined);
    if (ResolverError.is(err)) {
      if (err.code === 'INVALID_PASSWORD') {
        pendingPasswords.set(tgId, { url, requestId, expiresAt: Date.now() + PENDING_PASSWORD_TTL_MS });
        await c.reply(renderPasswordInvalid(), { parse_mode: 'HTML' });
        return;
      }
      const errMsg = renderErrorWithButtons(err.code, err.message, url);
      await c.reply(errMsg.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: errMsg.inlineKeyboard },
      });
      return;
    }
    ctx.log.error({ err, tgId }, 'telegram-bot: password resolve failed');
    const errMsg = renderErrorWithButtons('INTERNAL_ERROR', 'Something went wrong', url);
    await c.reply(errMsg.text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: errMsg.inlineKeyboard },
    });
  }
}
