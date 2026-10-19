import { findRoutes, type RouteQuery } from '../../../src/graph-engine/route-finder';
import { edgeNames, nodeNames, snap } from '../../helpers/engine';
import { mulberry32, routeOracle } from '../../helpers/route-oracle';

/**
 * Property test: on thousands of random small graphs (cycles, self-loops, unreachable nodes,
 * every combination of start / end / through) the engine must agree exactly with the slow
 * definition in route-oracle.ts.
 */
describe('findRoutes against an independent brute-force definition', () => {
  const CASES = 4_000;

  it(`agrees on ${CASES} random graphs and queries`, () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = mulberry32(seed);
      const n = 1 + Math.floor(random() * 7);
      const density = [0.08, 0.15, 0.25, 0.4][Math.floor(random() * 4)]!;

      const names = Array.from({ length: n }, (_, i) => `n${i}`);
      const adjacency = Array.from({ length: n }, () => Array.from({ length: n }, () => random() < density));
      const edges: Array<[string, string]> = [];
      adjacency.forEach((row, u) => row.forEach((has, v) => has && edges.push([names[u]!, names[v]!])));

      // Each role is absent (a third of the time) or a random subset, possibly empty.
      const role = (): boolean[] | null => (random() < 1 / 3 ? null : names.map(() => random() < 0.4));
      const starts = role();
      const ends = role();
      const through = role();

      const pick = (flags: boolean[] | null) => names.filter((_, i) => flags?.[i]);
      const snapshot = snap({
        nodes: names,
        edges,
        filters: { start: pick(starts), end: pick(ends), through: pick(through) },
      });
      const query: RouteQuery = {
        ...(starts ? { start: { filter: 'start' } } : {}),
        ...(ends ? { end: { filter: 'end' } } : {}),
        ...(through ? { through: { filter: 'through' } } : {}),
      };

      const expected = routeOracle({ n, adjacency, starts, ends, through });
      const actual = findRoutes(snapshot, query);

      const describeCase = `seed ${seed}: n=${n} edges=[${edges.map((e) => e.join('>')).join(' ')}] ` +
        `start=${JSON.stringify(starts && pick(starts))} end=${JSON.stringify(ends && pick(ends))} through=${JSON.stringify(through && pick(through))}`;

      expect({ case: describeCase, nodes: nodeNames(actual).sort() }).toEqual({
        case: describeCase,
        nodes: [...expected.nodes].map((i) => names[i]!).sort(),
      });
      expect({ case: describeCase, edges: edgeNames(actual) }).toEqual({
        case: describeCase,
        edges: [...expected.edges].map((e) => e.split('>').map((i) => names[Number(i)]).join('>')).sort(),
      });
    }
  });

  it('covers the interesting situations (guards against a generator that never produces them)', () => {
    let withCycle = 0;
    let withSelfLoop = 0;
    let nonEmptyWithThrough = 0;
    let emptyResult = 0;

    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = mulberry32(seed);
      const n = 1 + Math.floor(random() * 7);
      const density = [0.08, 0.15, 0.25, 0.4][Math.floor(random() * 4)]!;
      const adjacency = Array.from({ length: n }, () => Array.from({ length: n }, () => random() < density));
      const names = Array.from({ length: n }, (_, i) => `n${i}`);
      const role = (): boolean[] | null => (random() < 1 / 3 ? null : names.map(() => random() < 0.4));
      const starts = role();
      const ends = role();
      const through = role();

      const expected = routeOracle({ n, adjacency, starts, ends, through });
      if (adjacency.some((row, u) => row[u])) withSelfLoop += 1;
      const hasTwoCycle = adjacency.some((row, u) => row.some((has, v) => has && u !== v && adjacency[v]![u]));
      if (hasTwoCycle) withCycle += 1;
      if (through && expected.nodes.size > 0) nonEmptyWithThrough += 1;
      if (expected.nodes.size === 0) emptyResult += 1;
    }

    expect(withCycle).toBeGreaterThan(CASES * 0.1);
    expect(withSelfLoop).toBeGreaterThan(CASES * 0.1);
    expect(nonEmptyWithThrough).toBeGreaterThan(CASES * 0.05);
    expect(emptyResult).toBeGreaterThan(CASES * 0.05);
  });
});
