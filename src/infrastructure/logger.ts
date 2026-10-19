import pino from 'pino';

/**
 * The logging contract the application depends on. pino's Logger satisfies it,
 * so swapping the implementation only touches this file.
 */
export interface Logger {
  fatal(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerOptions): pino.Logger {
  return pino({
    level,
    base: { service: 'graph-analysis-backend' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Never log credentials or upload contents.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}
