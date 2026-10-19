import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The original sample file, byte for byte (also what `npm run seed` loads). */
export const SAMPLE_GRAPH_PATH = join(__dirname, '../../fixtures/train-ticket-be.json');

export const sampleGraphBuffer = (): Buffer => readFileSync(SAMPLE_GRAPH_PATH);
export const sampleGraphJson = (): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } =>
  JSON.parse(sampleGraphBuffer().toString('utf8'));

/** What the sample file contains once normalized (verified against the file itself). */
export const SAMPLE_EXPECTED = {
  definedNodes: 46,
  nodes: 47, // + the placeholder
  edges: 98,
  placeholders: ['assurance-service'],
} as const;
