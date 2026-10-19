import { z } from 'zod';
import type { OpenAPIRegistry } from '../../http/openapi/registry';

export const HealthReportSchema = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    database: z.enum(['up', 'down']),
    uptime: z.number().int().meta({ description: 'Process uptime in seconds' }),
    timestamp: z.iso.datetime(),
  })
  .meta({ id: 'HealthReport' });

export type HealthReport = z.infer<typeof HealthReportSchema>;

export function registerHealthDocs(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness and database connectivity',
    responses: {
      200: { description: 'Service and database are up', content: { 'application/json': { schema: HealthReportSchema } } },
      503: { description: 'Database is unreachable', content: { 'application/json': { schema: HealthReportSchema } } },
    },
  });
}
