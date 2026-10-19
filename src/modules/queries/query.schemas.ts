import { z } from 'zod';
import { errorResponse, type OpenAPIRegistry } from '../../http/openapi/registry';
import { FilterKeySchema } from '../filters/filter.schemas';
import { GraphIdParamsSchema, GraphEdgeResponseSchema, GraphNodeResponseSchema, GRAPHS_PATH } from '../graphs/graph.schemas';

/** A role may repeat (`?start=a&start=b`); more than this is surely a mistake. */
export const MAX_FILTERS_PER_ROLE = 20;

// --- request --------------------------------------------------------------------------------

const RoleFiltersSchema = z.union([FilterKeySchema, z.array(FilterKeySchema).min(1).max(MAX_FILTERS_PER_ROLE)]).optional();

/** Strict on purpose: a mistyped parameter (`?strat=public`) must fail, not silently return the whole graph. */
export const RouteQueryParamsSchema = z.strictObject({
  start: RoleFiltersSchema,
  end: RoleFiltersSchema,
  through: RoleFiltersSchema,
});

export type RouteQueryParams = z.infer<typeof RouteQueryParamsSchema>;

// --- response -------------------------------------------------------------------------------

export const RouteNodeResponseSchema = GraphNodeResponseSchema.extend({
  matched: z.object({
    roles: z.array(z.enum(['start', 'through', 'end'])).meta({
      description: 'Roles the node really plays: a start from which an end can be reached, a through node, an end reachable from a start',
    }),
    filters: z.array(z.string()).meta({ description: 'Filters named in the query that this node matches' }),
  }),
}).meta({ id: 'RouteNode' });

export const RouteResultResponseSchema = z
  .object({
    graphId: z.guid(),
    version: z.number().int().min(1).meta({ description: 'Graph version the answer was computed from' }),
    applied: z.object({
      start: z.array(z.string()),
      end: z.array(z.string()),
      through: z.array(z.string()),
    }).meta({ description: 'The filters used for each role, after removing repeats' }),
    nodes: z.array(RouteNodeResponseSchema),
    edges: z.array(GraphEdgeResponseSchema),
  })
  .meta({ id: 'RouteResult' });

export type RouteNodeResponse = z.infer<typeof RouteNodeResponseSchema>;
export type RouteResultResponse = z.infer<typeof RouteResultResponseSchema>;

// --- OpenAPI --------------------------------------------------------------------------------

export function registerQueryDocs(registry: OpenAPIRegistry): void {
  const role = (name: string, meaning: string) =>
    z.array(FilterKeySchema).max(MAX_FILTERS_PER_ROLE).optional().meta({ description: meaning, example: [name] });

  registry.registerPath({
    method: 'get',
    path: `${GRAPHS_PATH}/{id}/routes`,
    tags: ['Routes'],
    summary: 'Find the routes through a graph',
    description: [
      'Returns the subgraph (nodes and edges) made of everything that lies on at least one route that',
      'starts at a `start` node, ends at an `end` node and passes through a `through` node.',
      'A start or end node counts as a through node. Routes may go round a cycle.',
      '',
      '- Each role takes filter keys (see `GET /graphs/{id}/filters`); repeat the parameter to give several, e.g. `start=public&start=vulnerable`.',
      '- Several filters of one role are combined with **OR**; the three roles must all hold (**AND**).',
      '- A role left out puts no constraint on the route; with no role at all the whole graph is returned.',
      '- No matching route is a normal `200` with empty `nodes` and `edges`.',
    ].join('\n'),
    request: {
      params: GraphIdParamsSchema,
      query: z.object({
        start: role('public', 'Filters the route must start at (OR)'),
        end: role('sink', 'Filters the route must end at (OR)'),
        through: role('vulnerable', 'Filters the route must pass through (OR)'),
      }),
    },
    responses: {
      200: { description: 'The matching subgraph', content: { 'application/json': { schema: RouteResultResponseSchema } } },
      400: errorResponse('Malformed id, unknown query parameter, malformed filter key, or UNKNOWN_FILTER'),
      404: errorResponse('Graph not found'),
      409: errorResponse('FILTER_UNAVAILABLE: a stored filter rule can no longer be compiled'),
    },
  });
}
