import type { PrismaClient } from '../../infrastructure/prisma';
import type { HealthRepository } from './health.repository';

export class PrismaHealthRepository implements HealthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
