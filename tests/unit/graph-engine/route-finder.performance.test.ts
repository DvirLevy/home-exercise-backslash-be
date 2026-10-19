import { findRoutes } from '../../../src/graph-engine/route-finder';
import { buildSnapshot } from '../../../src/graph-engine/graph-snapshot';
import type { EngineEdge, EngineNode } from '../../../src/graph-engine/types';
import { mulberry32 } from '../../helpers/route-oracle';

/**
 * Smoke test at a size beyond what the default limits allow for a single upload
 * (50,000 nodes / 500,000 edges): the limit here is deliberately generous, it only has to catch
 * an accidental quadratic behaviour or a stack overflow.
 */
describe('route search on a large graph', () => {
  const NODES = 100_000;
  const EDGES = 500_000;
  const TIME_LIMIT_MS = 15_000;

  it(`builds ${NODES.toLocaleString()} nodes / ${EDGES.toLocaleString()} edges and answers the hardest query quickly`, () => {
    const random = mulberry32(2026);
    const nodes: EngineNode[] = Array.from({ length: NODES }, (_, i) => ({ name: `n${i}`, isPlaceholder: false }));
    const edges: EngineEdge[] = Array.from({ length: EDGES }, () => ({
      from: `n${Math.floor(random() * NODES)}`,
      to: `n${Math.floor(random() * NODES)}`,
    }));
    const every = (step: number, offset = 0) => (node: EngineNode) => (Number(node.name.slice(1)) + offset) % step === 0;

    const buildStart = performance.now();
    const snapshot = buildSnapshot(
      { id: 'big', version: 1, nodes, edges },
      new Map([
        ['public', every(5_000)],
        ['sink', every(7_000, 3)],
        ['vulnerable', every(2_500, 1)],
      ]),
    );
    const buildMs = performance.now() - buildStart;

    const queries = {
      'start + end + through': { start: { filter: 'public' }, end: { filter: 'sink' }, through: { filter: 'vulnerable' } },
      'start + end': { start: { filter: 'public' }, end: { filter: 'sink' } },
      'through only': { through: { filter: 'vulnerable' } },
      'combined filters': { start: { or: [{ filter: 'public' }, { filter: 'vulnerable' }] }, end: { and: [{ filter: 'sink' }, { not: { filter: 'public' } }] } },
    };
    const timings: string[] = [`build ${buildMs.toFixed(0)} ms`];
    let slowest = buildMs;
    for (const [label, query] of Object.entries(queries)) {
      const queryStart = performance.now();
      const result = findRoutes(snapshot, query);
      const elapsed = performance.now() - queryStart;
      timings.push(`${label}: ${elapsed.toFixed(0)} ms (${result.nodes.length} nodes)`);
      slowest = Math.max(slowest, elapsed);
      expect(result.nodes.length).toBeGreaterThan(0);
    }
    console.info(`large graph timings: ${timings.join(' | ')}`);

    expect(snapshot.edgeCount).toBeLessThanOrEqual(EDGES);
    expect(slowest).toBeLessThan(TIME_LIMIT_MS);
  }, 120_000);
});
