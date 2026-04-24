import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createLogger } from '@trs/logger';
import { makeRoutes } from './routes.js';

const log = createLogger({ service: 'admin-api' });

async function main(): Promise<void> {
  const app = express();
  app.set('trust proxy', true);
  app.use(helmet());
  app.use(express.json({ limit: '64kb' }));
  app.use(pinoHttp({ logger: log }));
  app.use(makeRoutes(log));

  const port = Number(process.env.ADMIN_API_PORT ?? 4002);
  app.listen(port, () => log.info({ port }, 'admin-api: listening'));
}

main().catch((err) => {
  log.fatal({ err }, 'admin-api: failed to start');
  process.exit(1);
});
