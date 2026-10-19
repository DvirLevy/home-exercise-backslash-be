import type { Logger } from '../../../../src/infrastructure/logger';
import { HealthService } from '../../../../src/modules/health/health.service';

const logger = { warn: jest.fn() } as unknown as Logger;

describe('HealthService', () => {
  it('reports ok when the database answers', async () => {
    const service = new HealthService({ ping: async () => undefined }, logger);

    const report = await service.check();

    expect(report).toMatchObject({ status: 'ok', database: 'up' });
    expect(Number.isInteger(report.uptime)).toBe(true);
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it('reports unavailable when the database ping fails', async () => {
    const service = new HealthService({ ping: async () => Promise.reject(new Error('refused')) }, logger);

    await expect(service.check()).resolves.toMatchObject({ status: 'unavailable', database: 'down' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports unavailable when the database ping hangs past the timeout', async () => {
    const service = new HealthService({ ping: () => new Promise<void>(() => undefined) }, logger, 20);

    await expect(service.check()).resolves.toMatchObject({ status: 'unavailable', database: 'down' });
  });
});
