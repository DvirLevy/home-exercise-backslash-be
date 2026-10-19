import type { Request, Response } from 'express';
import type { HealthService } from './health.service';

export class HealthController {
  constructor(private readonly service: HealthService) {}

  check = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.service.check();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  };
}
