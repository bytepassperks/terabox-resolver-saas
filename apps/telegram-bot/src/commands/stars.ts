import type { Bot } from 'grammy';
import { getPgPool } from '@trs/cache-layer';
import { PLAN_DEFINITIONS, StarsHandler, planFromInvoicePayload } from '@trs/credits-engine';
import type { BotContext } from '../bot.js';
import { renderPaymentSuccess } from '../ui.js';

/**
 * Telegram Stars payment flow:
 *   1. User taps a /buy button → `buy:<planId>` callback
 *   2. Bot sends invoice with prices=[{ label, amount: stars }]
 *   3. Telegram routes pre_checkout_query → we approve
 *   4. Telegram sends successful_payment → StarsHandler credits idempotently
 */
export function registerStarsHandlers(bot: Bot, ctx: BotContext): void {
  const handler = new StarsHandler({ pg: getPgPool(), credits: ctx.credits, log: ctx.log });

  bot.callbackQuery(/^buy:(.+)$/, async (c) => {
    const planId = c.match[1];
    const plan = PLAN_DEFINITIONS[planId as keyof typeof PLAN_DEFINITIONS];
    if (!plan || plan.stars <= 0) {
      await c.answerCallbackQuery({ text: 'Unknown plan', show_alert: true });
      return;
    }
    await c.answerCallbackQuery();
    await c.api.sendInvoice(
      c.chat!.id,
      `${plan.name} \u2014 ${plan.credits} credits`,
      `One-time purchase of ${plan.credits} resolve credits.`,
      JSON.stringify({ planId: plan.id, credits: plan.credits }),
      'XTR',
      [{ label: plan.name, amount: plan.stars }],
    );
  });

  bot.on('pre_checkout_query', async (c) => {
    const payload = safeParse(c.preCheckoutQuery.invoice_payload);
    const plan = planFromInvoicePayload(payload);
    if (!plan) {
      await c.answerPreCheckoutQuery(false, 'Unknown plan');
      return;
    }
    if (c.preCheckoutQuery.total_amount < plan.stars) {
      await c.answerPreCheckoutQuery(false, 'Amount mismatch');
      return;
    }
    await c.answerPreCheckoutQuery(true);
  });

  bot.on(':successful_payment', async (c) => {
    const sp = c.message!.successful_payment!;
    const outcome = await handler.handle({
      telegramChargeId: sp.telegram_payment_charge_id,
      providerPaymentChargeId: sp.provider_payment_charge_id ?? null,
      telegramUserId: c.from!.id,
      amountStars: sp.total_amount,
      payload: safeParse(sp.invoice_payload) ?? {},
      receivedAtMs: Date.now(),
    });
    if (outcome.credited) {
      const balance = await ctx.credits.getBalance(c.from!.id);
      const msg = renderPaymentSuccess(balance?.credits ?? 0);
      await c.reply(msg.text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: msg.inlineKeyboard },
      });
    } else {
      await c.reply(`\u26A0\uFE0F Payment received but not credited (${outcome.reason}). Contact support.`);
    }
  });
}

function safeParse(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
