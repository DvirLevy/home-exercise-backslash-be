import type { JsonObject } from '../../shared/json';
import type { FilterPreviewResponse, FilterResponse } from './filter.schemas';
import type { FilterPreview, FilterView } from './filter.service';

export function presentFilter({ record, matchCount }: FilterView): FilterResponse {
  return {
    key: record.key,
    description: record.description,
    builtin: record.isBuiltin,
    definition: record.definition as JsonObject,
    matchCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function presentPreview(preview: FilterPreview): FilterPreviewResponse {
  return { matchCount: preview.matchCount, matches: preview.matches };
}
