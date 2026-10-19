import type { Server } from 'node:http';
import type { Logger } from './logger';

export interface ShutdownOptions {
  server: Pick<Server, 'close' | 'closeIdleConnections'>;
  logger: Logger;
  /** Releases resources (DB connections etc.) after the server stops accepting requests. */
  cleanup: () => Promise<void>;
  timeoutMs?: number;
  exit?: (code: number) => void;
}

/**
 * Returns an idempotent shutdown function: stop accepting connections, let in-flight
 * requests finish, release resources, then exit. Forces exit if it takes too long.
 */
export function createShutdown({
  server,
  logger,
  cleanup,
  timeoutMs = 10_000,
  exit = (code) => process.exit(code),
}: ShutdownOptions): (signal: string) => Promise<void> {
  let shuttingDown = false;

  return async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    forceExit.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
      });
      await cleanup();
      clearTimeout(forceExit);
      logger.info({}, 'Shutdown complete');
      exit(0);
    } catch (err) {
      clearTimeout(forceExit);
      logger.error({ err }, 'Error during shutdown');
      exit(1);
    }
  };
}
