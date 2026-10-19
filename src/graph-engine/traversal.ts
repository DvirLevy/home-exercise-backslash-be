/**
 * Every name reachable from `seeds` (the seeds included) by repeatedly following `neighbours`.
 * Breadth-first with a plain array as the queue, so depth is never limited by the call stack
 * and every node is visited once, which also makes cycles and self-loops harmless.
 */
export function reachable(
  neighbours: (name: string) => Iterable<string>,
  seeds: Iterable<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const seed of seeds) {
    if (!visited.has(seed)) {
      visited.add(seed);
      queue.push(seed);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of neighbours(queue[head]!)) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}
