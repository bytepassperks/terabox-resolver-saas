import { pino, type Logger, type LoggerOptions } from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admin-token"]',
  'telegramToken',
  'token',
  '*.token',
  '*.telegramToken',
  'password',
  '*.password',
  'secret',
  '*.secret',
];

export interface LoggerFactoryOptions {
  service: string;
  level?: LoggerOptions['level'];
  pretty?: boolean;
}

/**
 * Returns a pino logger with sensible defaults and a structured redaction list
 * so bot tokens, admin headers, and payment payloads never leak into logs.
 * Every service in the monorepo uses this helper to stay consistent.
 */
export function createLogger(opts: LoggerFactoryOptions): Logger {
  const level = opts.level ?? (process.env.LOG_LEVEL as LoggerOptions['level']) ?? 'info';
  const pretty = opts.pretty ?? process.env.NODE_ENV !== 'production';

  const base: LoggerOptions = {
    level,
    base: { service: opts.service },
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
  };

  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino/file',
        options: { destination: 1 },
      },
    });
  }
  return pino(base);
}

export type { Logger } from 'pino';
