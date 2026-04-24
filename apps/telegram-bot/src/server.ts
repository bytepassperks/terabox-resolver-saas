import express from 'express';
import { webhookCallback } from 'grammy';
import { createLogger } from '@trs/logger';
import { buildBotContext, makePublicBot } from './bot.js';

const log = createLogger({ service: 'telegram-bot' });

async function main(): Promise<void> {
  const ctx = await buildBotContext(log);
  const bot = makePublicBot(ctx);

  const useWebhook = !!process.env.TELEGRAM_WEBHOOK_URL;
  if (!useWebhook) {
    log.info('telegram-bot: starting in long-polling mode');
    await bot.start({
      onStart: (info) => log.info({ username: info.username }, 'telegram-bot: polling started'),
    });
    return;
  }

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post(
    '/telegram/webhook',
    webhookCallback(bot, 'express', {
      secretToken: process.env.TELEGRAM_WEBHOOK_SECRET ?? undefined,
    }),
  );
  const port = Number(process.env.TELEGRAM_WEBHOOK_PORT ?? 4000);
  app.listen(port, () => log.info({ port }, 'telegram-bot: webhook listening'));
  await bot.api.setWebhook(`${process.env.TELEGRAM_WEBHOOK_URL}/telegram/webhook`, {
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET ?? undefined,
  });
}

main().catch((err) => {
  log.fatal({ err }, 'telegram-bot: failed to start');
  process.exit(1);
});
