import { z } from 'zod';
import { errorResponse, type OpenAPIRegistry } from '../../http/openapi/registry';

export const GRAPHS_PATH = '/api/v1/graphs';

// --- requests -------------------------------------------------------------------------------

// `guid` accepts any 8-4-4-4-12 hex id (what PostgreSQL accepts), not only RFC-versioned UUIDs.
export const GraphIdParamsSchema = z.object({ id: z.guid() });

/** Names are required but need not be unique; surrounding spaces are not kept. */
const GraphNameSchema = z.string().trim().min(1).max(200);

export const CreateGraphBodySchema = z.object({ name: GraphNameSchema });
export const ReplaceGraphBodySchema = z.object({ name: GraphNameSchema.optional() });
export const RenameGraphBodySchema = z.object({ name: GraphNameSchema });

// --- responses ------------------------------------------------------------------------------

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const GraphSummaryResponseSchema = z
  .object({
    id: z.guid(),
    name: z.string(),
    version: z.number().int().min(1).meta({ description: 'Increases on every change to nodes, edges or filters' }),
    nodeCount: z.number().int(),
    edgeCount: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'GraphSummary' });

export const GraphWriteResponseSchema = GraphSummaryResponseSchema.extend({
  placeholders: z.array(z.string()).meta({
    description: 'Nodes that edges referenced but the file did not define; they were added as placeholder nodes',
  }),
}).meta({ id: 'GraphWriteResult' });

export const GraphNodeResponseSchema = z
  .object({
    name: z.string(),
    kind: z.string().nullable().meta({ description: 'null for placeholder nodes' }),
    language: z.string().nullable(),
    path: z.string().nullable(),
    publicExposed: z.boolean().nullable().meta({ description: 'null when the file did not say; only true means exposed' }),
    placeholder: z.boolean().meta({ description: 'true for nodes created because an edge referenced them' }),
    vulnerabilities: z.array(JsonObjectSchema),
    metadata: JsonObjectSchema.nullable(),
    extra: JsonObjectSchema.nullable().meta({ description: 'Fields of the uploaded node that this API does not define' }),
  })
  .meta({ id: 'GraphNode' });

export const GraphEdgeResponseSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    extra: JsonObjectSchema.optional().meta({
      description: 'Fields of the uploaded edge that this API does not define. Omitted when there are none.',
    }),
  })
  .meta({ id: 'GraphEdge' });

export const GraphDetailResponseSchema = z
  .object({
    id: z.guid(),
    name: z.string(),
    version: z.number().int().min(1),
    extra: JsonObjectSchema.nullable().meta({
      description: 'Top-level fields of the uploaded file that this API does not define',
    }),
    nodes: z.array(GraphNodeResponseSchema),
    edges: z.array(GraphEdgeResponseSchema),
  })
  .meta({ id: 'GraphDetail' });

export type GraphSummaryResponse = z.infer<typeof GraphSummaryResponseSchema>;
export type GraphWriteResponse = z.infer<typeof GraphWriteResponseSchema>;
export type GraphNodeResponse = z.infer<typeof GraphNodeResponseSchema>;
export type GraphDetailResponse = z.infer<typeof GraphDetailResponseSchema>;

// --- OpenAPI --------------------------------------------------------------------------------

const etagHeader = {
  ETag: { description: 'Current graph version, e.g. "3". Send it back in If-Match to detect concurrent changes.', schema: { type: 'string' as const } },
};

const ifMatchHeader = z.object({
  'if-match': z.string().optional().meta({
    description: 'Version the client last saw (the ETag value). A mismatch returns 409.',
    example: '"3"',
  }),
});

const uploadFile = z.string().openapi({ format: 'binary', description: 'The graph as a JSON file' });

export function registerGraphDocs(registry: OpenAPIRegistry): void {
  const tags = ['Graphs'];
  const idParams = { params: GraphIdParamsSchema };

  registry.registerPath({
    method: 'post',
    path: GRAPHS_PATH,
    tags,
    summary: 'Create a graph from an uploaded JSON file',
    request: {
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              file: uploadFile,
              name: z.string().min(1).max(200).openapi({ description: 'Display name; need not be unique' }),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Graph created',
        headers: { ...etagHeader, Location: { description: 'URL of the new graph', schema: { type: 'string' } } },
        content: { 'application/json': { schema: GraphWriteResponseSchema } },
      },
      400: errorResponse('Missing file or name, invalid JSON, schema errors or duplicate node names'),
      413: errorResponse('File or graph too large'),
      415: errorResponse('Not multipart/form-data, or the file is not JSON'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: GRAPHS_PATH,
    tags,
    summary: 'List graphs (summaries only)',
    responses: {
      200: { description: 'All graphs, newest first', content: { 'application/json': { schema: z.array(GraphSummaryResponseSchema) } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${GRAPHS_PATH}/{id}`,
    tags,
    summary: 'Get a graph with its nodes and edges',
    request: idParams,
    responses: {
      200: { description: 'The graph', headers: etagHeader, content: { 'application/json': { schema: GraphDetailResponseSchema } } },
      400: errorResponse('Malformed id'),
      404: errorResponse('Graph not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: `${GRAPHS_PATH}/{id}`,
    tags,
    summary: 'Replace a graph\'s nodes and edges from an uploaded file',
    description: 'Atomic: either the whole new graph is stored or nothing changes. Filters are kept.',
    request: {
      ...idParams,
      headers: ifMatchHeader,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z.object({
              file: uploadFile,
              name: z.string().min(1).max(200).optional().openapi({ description: 'New name; the current one is kept when omitted' }),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'Graph replaced', headers: etagHeader, content: { 'application/json': { schema: GraphWriteResponseSchema } } },
      400: errorResponse('Invalid id, If-Match, file or name'),
      404: errorResponse('Graph not found'),
      409: errorResponse('VERSION_CONFLICT: the graph changed since the If-Match version'),
      413: errorResponse('File or graph too large'),
      415: errorResponse('Not multipart/form-data, or the file is not JSON'),
    },
  });

  registry.registerPath({
    method: 'patch',
    path: `${GRAPHS_PATH}/{id}`,
    tags,
    summary: 'Rename a graph',
    description: 'Does not change the version.',
    request: {
      ...idParams,
      body: { required: true, content: { 'application/json': { schema: RenameGraphBodySchema } } },
    },
    responses: {
      200: { description: 'Graph renamed', headers: etagHeader, content: { 'application/json': { schema: GraphSummaryResponseSchema } } },
      400: errorResponse('Invalid id or name'),
      404: errorResponse('Graph not found'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: `${GRAPHS_PATH}/{id}`,
    tags,
    summary: 'Delete a graph with its nodes, edges and filters',
    request: idParams,
    responses: {
      204: { description: 'Graph deleted' },
      400: errorResponse('Malformed id'),
      404: errorResponse('Graph not found'),
    },
  });
}
