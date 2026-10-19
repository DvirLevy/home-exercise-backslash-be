/**
 * A slow, independent definition of "the nodes and edges that lie on at least one route", used
 * to check the real implementation. It does not use the two-searches shortcut of the engine:
 * it builds the product graph of (node, "has passed through M yet") states, takes its full
 * transitive closure (Floyd-Warshall) and asks the definition directly:
 *   x is on a route  <=>  some start state reaches a state of x, and that state reaches an accepting state.
 */
export interface OracleInput {
  n: number;
  /** adjacency[u][v] is true when there is an edge u -> v (self-loops allowed). */
  adjacency: boolean[][];
  /** null = the role is not constrained. */
  starts: boolean[] | null;
  ends: boolean[] | null;
  through: boolean[] | null;
}

export interface OracleResult {
  nodes: Set<number>;
  edges: Set<string>;
}

export function routeOracle({ n, adjacency, starts, ends, through }: OracleInput): OracleResult {
  const hasThrough = through !== null;
  const inThrough = (v: number): number => (hasThrough && through![v] ? 1 : 0);
  const state = (v: number, passed: number): number => v * 2 + passed;
  const size = 2 * n;

  // reach[a][b]: state b can be reached from state a by a walk of length >= 0.
  const reach: boolean[][] = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i === j));
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      if (!adjacency[u]![v]) continue;
      for (let passed = 0; passed < 2; passed += 1) {
        reach[state(u, passed)]![state(v, passed | inThrough(v))] = true;
      }
    }
  }
  for (let k = 0; k < size; k += 1) {
    for (let i = 0; i < size; i += 1) {
      if (!reach[i]![k]) continue;
      for (let j = 0; j < size; j += 1) if (reach[k]![j]) reach[i]![j] = true;
    }
  }

  const startStates: number[] = [];
  const acceptStates: number[] = [];
  for (let v = 0; v < n; v += 1) {
    if (!starts || starts[v]) startStates.push(state(v, inThrough(v)));
    if (!ends || ends[v]) acceptStates.push(state(v, hasThrough ? 1 : 0));
  }
  const fromStart = (target: number): boolean => startStates.some((s) => reach[s]![target]);
  const toAccept = (source: number): boolean => acceptStates.some((a) => reach[source]![a]);

  const nodes = new Set<number>();
  const edges = new Set<string>();
  for (let x = 0; x < n; x += 1) {
    for (let passed = 0; passed < 2; passed += 1) {
      if (fromStart(state(x, passed)) && toAccept(state(x, passed))) nodes.add(x);
    }
  }
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      if (!adjacency[u]![v]) continue;
      for (let passed = 0; passed < 2; passed += 1) {
        if (fromStart(state(u, passed)) && toAccept(state(v, passed | inThrough(v)))) edges.add(`${u}>${v}`);
      }
    }
  }
  return { nodes, edges };
}

/** Small deterministic random number generator, so a failing case can be replayed from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
