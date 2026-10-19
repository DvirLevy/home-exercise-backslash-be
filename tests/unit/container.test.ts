import { loadEnv } from '../../src/config/env';
import { createContainer, createServices, type Persistence } from '../../src/container';
import { disconnectPrisma } from '../../src/infrastructure/prisma';
import { fakeFilterRepository, fakeGraphRepository, fakeUnitOfWork, silentTestLogger } from '../helpers/fakes';
import { GRAPH_ID, smallGraph } from '../helpers/loaded';

const DATABASE_URL = 'postgresql://user:pass@localhost:5432/graphs';
const env = (extra: Record<string, string> = {}) => loadEnv({ DATABASE_URL, LOG_LEVEL: 'silent', NODE_ENV: 'test', ...extra });

describe('createContainer', () => {
  afterEach(async () => {
    await disconnectPrisma();
  });

  it('uses the single PrismaClient of the process, however many containers are built', () => {
    const first = createContainer(env());
    const second = createContainer(env());

    expect(second.prisma).toBe(first.prisma);
  });

  it('closes that client on dispose, so the next container gets a fresh one', async () => {
    const first = createContainer(env());

    await first.dispose();
    const second = createContainer(env());

    expect(second.prisma).not.toBe(first.prisma);
  });

  it('gives the in-memory graph store the size set in GRAPH_CACHE_MAX_ENTRIES', () => {
    expect(createContainer(env({ GRAPH_CACHE_MAX_ENTRIES: '7' })).services.graphStore.maxEntries).toBe(7);
  });

  it('keeps the default of 50 when GRAPH_CACHE_MAX_ENTRIES is not set', () => {
    expect(createContainer(env()).services.graphStore.maxEntries).toBe(50);
  });

  it('builds the services once: the app and the seed script share one store', () => {
    const container = createContainer(env());

    expect(container.services.graphStore).toBe(container.services.graphStore);
    expect(container.services.graphService).toBeDefined();
  });
});

describe('createServices and the in-memory graph store', () => {
  /** Fake storage that has a graph for every id asked for. */
  function persistence(): Persistence {
    return {
      repositories: {
        health: { ping: async () => undefined },
        graphs: fakeGraphRepository({ findWithData: jest.fn(async (id: string) => smallGraph({ id })) }),
        filters: fakeFilterRepository(),
      },
      unitOfWork: fakeUnitOfWork(),
    };
  }
  const limits = { maxUploadBytes: 1_000, maxNodes: 10, maxEdges: 10 };
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `${GRAPH_ID.slice(0, -2)}${String(i).padStart(2, '0')}`);

  it('keeps at most the configured number of graphs in memory, dropping the least recently used', async () => {
    const { graphStore } = createServices({ persistence: persistence(), limits, logger: silentTestLogger, graphCacheMaxEntries: 3 });

    for (const id of ids(5)) await graphStore.get(id);

    expect(graphStore.size).toBe(3);
  });

  it('keeps 50 graphs by default', async () => {
    const { graphStore } = createServices({ persistence: persistence(), limits, logger: silentTestLogger });

    for (const id of ids(60)) await graphStore.get(id);

    expect(graphStore.size).toBe(50);
  });

  it('reloads a graph that was dropped, and serves one that is still kept from memory', async () => {
    const storage = persistence();
    const { graphStore } = createServices({ persistence: storage, limits, logger: silentTestLogger, graphCacheMaxEntries: 2 });
    const [a, b, c] = ids(3) as [string, string, string];

    await graphStore.get(a);
    await graphStore.get(b);
    await graphStore.get(c); // drops a
    await graphStore.get(b); // still in memory
    await graphStore.get(a); // loaded again

    expect(storage.repositories.graphs.findWithData).toHaveBeenCalledTimes(4);
  });

  it('rejects a size that makes no sense', () => {
    expect(() => createServices({ persistence: persistence(), limits, logger: silentTestLogger, graphCacheMaxEntries: 0 })).toThrow(RangeError);
  });
});
