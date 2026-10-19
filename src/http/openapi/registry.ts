import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds `.openapi()` to Zod schemas; required by registry.register() and parameter metadata.
extendZodWithOpenApi(z);

export { OpenAPIRegistry };

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'VALIDATION_ERROR' }),
      message: z.string(),
      details: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .optional(),
    }),
  })
  .meta({ id: 'ErrorResponse', description: 'Shared error format for every non-2xx response' });

export function createOpenApiRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.register('ErrorResponse', ErrorResponseSchema);
  return registry;
}

export function errorResponse(description: string) {
  return { description, content: { 'application/json': { schema: ErrorResponseSchema } } };
}

export function buildOpenApiDocument(registry: OpenAPIRegistry) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Graph Analysis Platform API',
      version: '1.0.0',
      description:
        'Upload microservice architecture graphs and query routes between services using dynamic filters.',
    },
  });
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
