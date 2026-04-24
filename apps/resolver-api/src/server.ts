import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createLogger } from '@trs/logger';
import { createResolverApp } from './app.js';

const log = createLogger({ service: 'resolver-api' });

async function main(): Promise<void> {
  const app = await createResolverApp(log);
  const port = Number(process.env.RESOLVER_PORT ?? 4001);

  // Trust proxy headers so rate-limit-engine sees the real client IP behind
  // Render/Cloudflare, not the edge node's private IP.
  app.set('trust proxy', true);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(pinoHttp({ logger: log }));

  const server = app.listen(port, () => {
    log.info({ port }, 'resolver-api: listening');
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'resolver-api: shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err }, 'resolver-api: failed to start');
  process.exit(1);
});
