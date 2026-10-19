import { createShutdown } from '../../../src/infrastructure/graceful-shutdown';
import type { Logger } from '../../../src/infrastructure/logger';

const logger = { info: jest.fn(), error: jest.fn() } as unknown as Logger;

function fakeServer(closeError?: Error) {
  return {
    close: jest.fn((callback?: (err?: Error) => void) => {
      callback?.(closeError);
      return undefined as never;
    }),
    closeIdleConnections: jest.fn(),
  };
}

describe('createShutdown', () => {
  it('closes the server, runs cleanup, then exits with 0', async () => {
    const order: string[] = [];
    const server = fakeServer();
    server.close.mockImplementation((callback) => {
      order.push('close');
      callback?.();
      return undefined as never;
    });
    const cleanup = jest.fn(async () => {
      order.push('cleanup');
    });
    const exit = jest.fn();

    await createShutdown({ server, logger, cleanup, exit })('SIGTERM');

    expect(order).toEqual(['close', 'cleanup']);
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 1 when closing fails', async () => {
    const exit = jest.fn();

    await createShutdown({ server: fakeServer(new Error('close failed')), logger, cleanup: jest.fn(), exit })('SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('runs only once when several signals arrive', async () => {
    const cleanup = jest.fn(async () => undefined);
    const exit = jest.fn();
    const shutdown = createShutdown({ server: fakeServer(), logger, cleanup, exit });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('forces exit with 1 when shutdown exceeds the timeout', async () => {
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      const hangingCleanup = () => new Promise<void>(() => undefined);

      void createShutdown({ server: fakeServer(), logger, cleanup: hangingCleanup, exit, timeoutMs: 1_000 })('SIGTERM');
      await jest.advanceTimersByTimeAsync(1_000);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
