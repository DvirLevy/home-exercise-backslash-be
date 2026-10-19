import type { Logger } from '../../infrastructure/logger';
import type { HealthRepository } from './health.repository';
import type { HealthReport } from './health.schemas';

const DEFAULT_DB_TIMEOUT_MS = 2_000;

export class HealthService {
  constructor(
    private readonly repository: HealthRepository,
    private readonly logger: Logger,
    private readonly dbTimeoutMs = DEFAULT_DB_TIMEOUT_MS,
  ) {}

  async check(): Promise<HealthReport> {
    const databaseUp = await this.isDatabaseUp();
    return {
      status: databaseUp ? 'ok' : 'unavailable',
      database: databaseUp ? 'up' : 'down',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  private async isDatabaseUp(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database ping timed out')), this.dbTimeoutMs);
    });
    try {
      await Promise.race([this.repository.ping(), timeout]);
      return true;
    } catch (err) {
      this.logger.warn({ err }, 'Database health check failed');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
