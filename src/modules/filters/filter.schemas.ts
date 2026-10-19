import { z } from 'zod';
import { errorResponse, type OpenAPIRegistry } from '../../http/openapi/registry';
import { GraphIdParamsSchema, GRAPHS_PATH } from '../graphs/graph.schemas';
import { FILTER_KEY_PATTERN, MAX_FILTERS_PER_GRAPH } from './filter.types';
import { OPERATORS, RULE_LIMITS } from './rules/rule.types';

// --- requests -------------------------------------------------------------------------------

export const FilterKeySchema = z
  .string()
  .regex(FILTER_KEY_PATTERN, {
    error: 'must be 1-63 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen',
  })
  .meta({ description: 'Used in URLs, e.g. ?start=public', example: 'high-severity' });

export const FilterParamsSchema = GraphIdParamsSchema.extend({ key: FilterKeySchema });

const DescriptionSchema = z.string().trim().max(500).nullish();

// The rule is checked by parseRule(), which reports every problem with its exact path.
const DefinitionSchema = z.unknown().meta({
  description: `The filter rule (see "Filter rules" in the README): { all }, { any }, { not } or a field check. At most ${RULE_LIMITS.maxDepth} levels deep and ${RULE_LIMITS.maxRules} parts.`,
  example: { field: 'kind', op: 'in', value: ['rds', 'sql'] },
});

export const CreateFilterBodySchema = z.strictObject({
  key: FilterKeySchema,
  description: DescriptionSchema,
  definition: DefinitionSchema,
});

/** PUT replaces the whole filter: a description left out clears it. */
export const ReplaceFilterBodySchema = z.strictObject({
  description: DescriptionSchema,
  definition: DefinitionSchema,
});

export const PreviewFilterBodySchema = z.strictObject({ definition: DefinitionSchema });

// --- responses ------------------------------------------------------------------------------

const RuleResponseSchema = z.record(z.string(), z.unknown());

export const FilterResponseSchema = z
  .object({
    key: z.string(),
    description: z.string().nullable(),
    builtin: z.boolean().meta({ description: 'Built-in filters are read-only' }),
    definition: RuleResponseSchema,
    matchCount: z.number().int().nullable().meta({
      description: 'Nodes of this graph matching the filter; null if the stored rule can no longer be compiled',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Filter' });

export const FilterPreviewResponseSchema = z
  .object({
    matchCount: z.number().int(),
    matches: z.array(z.string()).meta({ description: 'Names of the matching nodes, in file order' }),
  })
  .meta({ id: 'FilterPreview' });

export type FilterResponse = z.infer<typeof FilterResponseSchema>;
export type FilterPreviewResponse = z.infer<typeof FilterPreviewResponseSchema>;

// --- OpenAPI --------------------------------------------------------------------------------

export function registerFilterDocs(registry: OpenAPIRegistry): void {
  const tags = ['Filters'];
  const base = `${GRAPHS_PATH}/{id}/filters`;
  const graphParams = { params: GraphIdParamsSchema };
  const keyParams = { params: FilterParamsSchema };
  const bumpNote = 'Changing filters changes query results, so it increases the graph version.';

  registry.registerPath({
    method: 'get',
    path: base,
    tags,
    summary: 'List the filters of a graph',
    description: 'Built-in filters first, then custom ones, each ordered by key.',
    request: graphParams,
    responses: {
      200: { description: 'The filters', content: { 'application/json': { schema: z.array(FilterResponseSchema) } } },
      400: errorResponse('Malformed id'),
      404: errorResponse('Graph not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: base,
    tags,
    summary: 'Create a custom filter',
    description: `${bumpNote} A graph holds at most ${MAX_FILTERS_PER_GRAPH} filters in total.`,
    request: { ...graphParams, body: { required: true, content: { 'application/json': { schema: CreateFilterBodySchema } } } },
    responses: {
      201: {
        description: 'Filter created',
        headers: { Location: { description: 'URL of the new filter', schema: { type: 'string' } } },
        content: { 'application/json': { schema: FilterResponseSchema } },
      },
      400: errorResponse(`Invalid key or rule (INVALID_FILTER_RULE lists every problem; operators: ${OPERATORS.join(', ')})`),
      404: errorResponse('Graph not found'),
      409: errorResponse('FILTER_KEY_EXISTS or FILTER_LIMIT_REACHED'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${base}/preview`,
    tags,
    summary: 'Try a rule without saving it',
    description: 'Returns the nodes the rule would match. Nothing is stored and the version does not change.',
    request: { ...graphParams, body: { required: true, content: { 'application/json': { schema: PreviewFilterBodySchema } } } },
    responses: {
      200: { description: 'The matching nodes', content: { 'application/json': { schema: FilterPreviewResponseSchema } } },
      400: errorResponse('Invalid rule'),
      404: errorResponse('Graph not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${base}/{key}`,
    tags,
    summary: 'Get one filter',
    request: keyParams,
    responses: {
      200: { description: 'The filter', content: { 'application/json': { schema: FilterResponseSchema } } },
      400: errorResponse('Malformed id or key'),
      404: errorResponse('Graph or filter not found'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: `${base}/{key}`,
    tags,
    summary: 'Replace a custom filter',
    description: `Replaces the description and the rule; the key never changes. ${bumpNote}`,
    request: { ...keyParams, body: { required: true, content: { 'application/json': { schema: ReplaceFilterBodySchema } } } },
    responses: {
      200: { description: 'Filter replaced', content: { 'application/json': { schema: FilterResponseSchema } } },
      400: errorResponse('Invalid rule'),
      404: errorResponse('Graph or filter not found'),
      409: errorResponse('BUILTIN_FILTER_READ_ONLY'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: `${base}/{key}`,
    tags,
    summary: 'Delete a custom filter',
    description: bumpNote,
    request: keyParams,
    responses: {
      204: { description: 'Filter deleted' },
      400: errorResponse('Malformed id or key'),
      404: errorResponse('Graph or filter not found'),
      409: errorResponse('BUILTIN_FILTER_READ_ONLY'),
    },
  });
}
