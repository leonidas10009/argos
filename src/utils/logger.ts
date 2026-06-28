import pino from 'pino';
import type { LogLevel } from '../types';

let logger: pino.Logger;

export function createLogger(level: LogLevel = 'info', name?: string): pino.Logger {
  logger = pino({
    name: name || 'scraper',
    level,
    transport: process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  });
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    logger = createLogger();
  }
  return logger;
}
