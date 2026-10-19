import { findRoutes } from '../../../src/graph-engine/route-finder';
import { SAMPLE_EXPECTED } from '../../helpers/sample-graph-file';
import { sampleSnapshot } from '../../helpers/sample-engine';
import { sorted } from '../../helpers/engine';

const snapshot = sampleSnapshot();
const names = (result: ReturnType<typeof findRoutes>) => result.nodes.map((n) => n.node.name);
const edges = (result: ReturnType<typeof findRoutes>) => result.edges.map((e) => `${e.from}>${e.to}`);

const publicNodes = { filter: 'public' };
const sink = { filter: 'sink' };
const vulnerable = { filter: 'vulnerable' };

describe('the sample file in the engine', () => {
  it('builds a snapshot with the expected size', () => {
    expect(snapshot.nodes.size).toBe(SAMPLE_EXPECTED.nodes);
    expect(snapshot.edgeCount).toBe(SAMPLE_EXPECTED.edges);
    expect(snapshot.nodes.get('assurance-service')?.isPlaceholder).toBe(true);
  });

  it('indexes the built-in filters', () => {
    expect(sorted(snapshot.filterIndex.get('public')!)).toEqual(['frontend', 'gateway-service']);
    expect(sorted(snapshot.filterIndex.get('sink')!)).toEqual(['prod-postgresdb']);
    expect(sorted(snapshot.filterIndex.get('vulnerable')!)).toEqual(['auth-service', 'order-service']);
  });

  it('holds both adjacency lists correctly', () => {
    expect(sorted(snapshot.successors('auth-service'))).toEqual(['prod-postgresdb', 'verification-code-service']);
    expect(sorted(snapshot.predecessors('prod-postgresdb'))).toEqual(['auth-service', 'order-service']);
    expect(sorted(snapshot.successors('consign-service'))).toEqual(['consign-price-service']); // the edge written as a single string
    expect(sorted(snapshot.predecessors('assurance-service'))).toEqual(['preserve-other-service', 'preserve-service']);
    expect([...snapshot.successors('gateway-service')]).toEqual([]); // public, but connected to nothing
  });

  describe('public services to database sinks', () => {
    it('finds no route: nothing public reaches the database', () => {
      expect(findRoutes(snapshot, { start: publicNodes, end: sink })).toEqual({ nodes: [], edges: [] });
    });

    it('shows why: the frontend only reaches a handful of services, none of them a sink', () => {
      const result = findRoutes(snapshot, { start: publicNodes });

      expect(names(result).sort()).toEqual(
        ['admin-basic-info-service', 'config-service', 'contacts-service', 'frontend', 'gateway-service', 'price-service', 'station-service', 'train-service'],
      );
    });
  });

  describe('routes through a vulnerable node to a database sink', () => {
    const result = findRoutes(snapshot, { through: vulnerable, end: sink });
    const found = new Set(names(result));

    it('contains the vulnerable nodes and the database', () => {
      expect(found).toContain('order-service');
      expect(found).toContain('auth-service');
      expect(found).toContain('prod-postgresdb');
    });

    it('leaves out the queue, which is not a sink', () => {
      expect(found).not.toContain('prod-sqs');
    });

    it('includes services that can reach a vulnerable node (before it) and the sink behind it', () => {
      expect(found).toContain('user-service'); // user-service -> auth-service -> prod-postgresdb
      expect(found).toContain('cancel-service'); // -> order-service
      expect(found).toContain('seat-service'); // -> order-service
    });

    it('leaves out what does not lead to a sink through a vulnerable node', () => {
      expect(found).not.toContain('frontend');
      expect(found).not.toContain('gateway-service');
      expect(found).not.toContain('verification-code-service'); // auth-service -> it, but it leads nowhere
      expect(found).not.toContain('station-service'); // order-service -> station-service is a dead end
      expect(found).not.toContain('assurance-service');
    });

    it('only uses edges between nodes that are on a route', () => {
      for (const edge of result.edges) {
        expect(found.has(edge.from)).toBe(true);
        expect(found.has(edge.to)).toBe(true);
      }
      expect(edges(result)).toContain('auth-service>prod-postgresdb');
      expect(edges(result)).toContain('order-service>prod-postgresdb');
      expect(edges(result)).not.toContain('auth-service>verification-code-service');
    });

    it('tags the roles', () => {
      const byName = new Map(result.nodes.map((n) => [n.node.name, n]));

      expect(byName.get('prod-postgresdb')?.roles).toEqual(['end']);
      expect(byName.get('order-service')?.roles).toEqual(['through']);
      expect(byName.get('order-service')?.filters).toEqual(['vulnerable']);
      expect(byName.get('prod-postgresdb')?.filters).toEqual(['sink']);
      expect(byName.get('user-service')?.roles).toEqual([]);
    });
  });

  it('finds every route to the database when only the end is given', () => {
    const result = findRoutes(snapshot, { end: sink });

    expect(names(result)).toContain('prod-postgresdb');
    expect(names(result)).toContain('inside-payment-service'); // -> order-service -> database
    expect(names(result)).not.toContain('prod-sqs');
  });

  it('combines filters of one role with OR', () => {
    const result = findRoutes(snapshot, { start: { or: [{ filter: 'public' }, { filter: 'vulnerable' }] }, end: sink });

    expect(names(result)).toContain('auth-service');
    expect(names(result)).toContain('order-service');
    expect(names(result)).not.toContain('frontend');
  });

  it('returns the whole graph, placeholder included, when nothing is asked', () => {
    const result = findRoutes(snapshot, {});

    expect(result.nodes).toHaveLength(SAMPLE_EXPECTED.nodes);
    expect(result.edges).toHaveLength(SAMPLE_EXPECTED.edges);
  });
});
