import { Bot } from 'grammy';
import type { Logger } from '@trs/logger';
import { getPgPool, getRedisClient } from '@trs/cache-layer';
import { CreditsService } from '@trs/credits-engine';
import {
  AbuseDetector,
  RateLimiter,
  readRateLimitConfigFromEnv,
} from '@trs/rate-limit-engine';
import { TokenPool, readTokenPoolConfigFromEnv } from '@trs/bot-router';
import { ResolverClient } from './resolver-client.js';
import { registerUserCommands } from './commands/user.js';
import { registerAdminCommands } from './commands/admin.js';
import { registerStarsHandlers } from './commands/stars.js';

export interface BotContext {
  log: Logger;
  credits: CreditsService;
  rateLimiter: RateLimiter;
  abuse: AbuseDetector;
  resolver: ResolverClient;
  tokenPool: TokenPool;
  publicToken: string;
}

export async function buildBotContext(log: Logger): Promise<BotContext> {
  const tokensRaw = process.env.TELEGRAM_BOT_TOKENS ?? '';
  const seeds = TokenPool.fromEnv(tokensRaw);
  if (seeds.length === 0) {
    throw new Error('TELEGRAM_BOT_TOKENS must contain at least one token');
  }
  const publicToken = seeds[0]!.token;

  const redis = getRedisClient();
  const pg = getPgPool();
  const tokenPool = new TokenPool(seeds, redis, readTokenPoolConfigFromEnv(), log);
  const credits = new CreditsService({
    pg,
    log,
    resolveCost: Number(process.env.CREDIT_COST_PER_RESOLVE ?? 1),
    freeDailyCredits: Number(process.env.FREE_DAILY_CREDITS ?? 3),
  });
  const rateLimiter = new RateLimiter(redis, readRateLimitConfigFromEnv());
  const abuse = new AbuseDetector(redis, readRateLimitConfigFromEnv().keyPrefix);
  const resolver = new ResolverClient({
    baseUrl: process.env.RESOLVER_API_URL ?? 'http://localhost:4001',
    internalToken: process.env.RESOLVER_API_INTERNAL_TOKEN ?? '',
    log,
  });
  return { log, credits, rateLimiter, abuse, resolver, tokenPool, publicToken };
}

export function makePublicBot(ctx: BotContext): Bot {
  const bot = new Bot(ctx.publicToken);
  registerUserCommands(bot, ctx);
  registerStarsHandlers(bot, ctx);
  registerAdminCommands(bot, ctx);
  bot.catch((err) => {
    ctx.log.error({ err }, 'telegram-bot: unhandled error');
  });
  return bot;
}
