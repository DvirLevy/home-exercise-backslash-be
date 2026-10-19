import { GraphStore } from '../../../src/graph-engine/graph-store';
import type { GraphCache } from '../../../src/modules/graphs/graph-cache';

interface Snap {
  id: string;
  version: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A loader that serves versions from `versions` and counts its calls. */
function countingLoader(versions: Record<string, number>) {
  const load = jest.fn(async (id: string): Promise<Snap | null> => (id in versions ? { id, version: versions[id]! } : null));
  return load;
}

describe('GraphStore', () => {
  it('loads a graph on first use and then serves it from memory', async () => {
    const load = countingLoader({ a: 1 });
    const store = new GraphStore(load);

    const first = await store.get('a');
    const second = await store.get('a');

    expect(first).toEqual({ id: 'a', version: 1 });
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it('shares one load between readers that arrive while it is running', async () => {
    const gate = deferred<Snap | null>();
    const load = jest.fn(() => gate.promise);
    const store = new GraphStore(load);

    const readers = [store.get('a'), store.get('a'), store.get('a')];
    gate.resolve({ id: 'a', version: 1 });
    const results = await Promise.all(readers);

    expect(load).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('keeps graphs apart', async () => {
    const load = countingLoader({ a: 1, b: 2 });
    const store = new GraphStore(load);

    expect(await store.get('a')).toEqual({ id: 'a', version: 1 });
    expect(await store.get('b')).toEqual({ id: 'b', version: 2 });
    store.invalidate('a');
    await store.get('b');

    expect(load.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  describe('missing graphs and failures', () => {
    it('returns null for an unknown graph and does not cache that', async () => {
      const load = countingLoader({});
      const store = new GraphStore(load);

      expect(await store.get('nope')).toBeNull();
      expect(await store.get('nope')).toBeNull();

      expect(load).toHaveBeenCalledTimes(2);
      expect(store.size).toBe(0);
    });

    it('rejects every waiting reader when the load fails, then tries again next time', async () => {
      const gate = deferred<Snap | null>();
      const load = jest.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce({ id: 'a', version: 1 });
      const store = new GraphStore<Snap>(load);

      const readers = [store.get('a'), store.get('a')];
      gate.reject(new Error('database down'));

      await expect(readers[0]).rejects.toThrow('database down');
      await expect(readers[1]).rejects.toThrow('database down');
      expect(store.size).toBe(0);
      expect(await store.get('a')).toEqual({ id: 'a', version: 1 });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidate', () => {
    it('drops the entry so the next read loads fresh data', async () => {
      const versions = { a: 1 };
      const load = countingLoader(versions);
      const store = new GraphStore(load);
      await store.get('a');

      versions.a = 2;
      store.invalidate('a');

      expect(store.size).toBe(0);
      expect(await store.get('a')).toEqual({ id: 'a', version: 2 });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does nothing for a graph that is not cached', async () => {
      const load = countingLoader({ a: 1 });
      const store = new GraphStore(load);
      await store.get('a');

      store.invalidate('other');

      expect(store.size).toBe(1);
    });

    it('is usable as the cache the write path talks to', () => {
      const cache: GraphCache = new GraphStore(countingLoader({}));

      expect(() => cache.invalidate('a')).not.toThrow();
    });

    it('lets readers already waiting have the result of a load that began before the write, but never keeps it', async () => {
      const slow = deferred<Snap | null>();
      const load = jest.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ id: 'a', version: 2 });
      const store = new GraphStore<Snap>(load);

      const early = store.get('a'); // starts the slow load of version 1
      store.invalidate('a'); // a write commits meanwhile
      slow.resolve({ id: 'a', version: 1 });

      expect(await early).toEqual({ id: 'a', version: 1 });
      expect(store.size).toBe(0); // the stale result was not kept
      expect(await store.get('a')).toEqual({ id: 'a', version: 2 });
    });

    it('starts a fresh load for a reader that arrives after the invalidation', async () => {
      const slow = deferred<Snap | null>();
      const load = jest.fn().mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ id: 'a', version: 2 });
      const store = new GraphStore<Snap>(load);

      const early = store.get('a');
      store.invalidate('a');
      const late = await store.get('a'); // does not join the stale load

      expect(late).toEqual({ id: 'a', version: 2 });
      expect(load).toHaveBeenCalledTimes(2);
      slow.resolve({ id: 'a', version: 1 });
      await early;
    });

    it('a stale load never overwrites a newer snapshot, whichever finishes last', async () => {
      const slowOld = deferred<Snap | null>();
      const load = jest.fn().mockReturnValueOnce(slowOld.promise).mockResolvedValueOnce({ id: 'a', version: 2 });
      const store = new GraphStore<Snap>(load);

      const early = store.get('a'); // slow load of version 1
      store.invalidate('a');
      expect(await store.get('a')).toEqual({ id: 'a', version: 2 }); // fast load of version 2, cached
      slowOld.resolve({ id: 'a', version: 1 }); // the old load finishes last
      await early;

      expect(await store.get('a')).toEqual({ id: 'a', version: 2 });
      expect(load).toHaveBeenCalledTimes(2); // served from memory, no third load
    });
  });

  describe('clear', () => {
    it('drops everything, including the results of loads in flight', async () => {
      const slow = deferred<Snap | null>();
      const load = jest.fn().mockResolvedValueOnce({ id: 'b', version: 1 }).mockReturnValueOnce(slow.promise);
      const store = new GraphStore<Snap>(load);
      await store.get('b');
      const inFlight = store.get('a');

      store.clear();
      slow.resolve({ id: 'a', version: 1 });
      await inFlight;

      expect(store.size).toBe(0);
    });
  });

  describe('memory bound', () => {
    it('evicts the least recently used snapshot beyond maxEntries', async () => {
      const load = countingLoader({ a: 1, b: 1, c: 1 });
      const store = new GraphStore(load, { maxEntries: 2 });

      await store.get('a');
      await store.get('b');
      await store.get('a'); // a is now more recent than b
      await store.get('c'); // evicts b
      expect(store.size).toBe(2);

      await store.get('a'); // still cached
      await store.get('c'); // still cached
      expect(load).toHaveBeenCalledTimes(3);
      await store.get('b'); // was evicted: loads again
      expect(load).toHaveBeenCalledTimes(4);
    });

    it.each([0, -1, 1.5, Number.NaN])('rejects maxEntries %p', (maxEntries) => {
      expect(() => new GraphStore(countingLoader({}), { maxEntries })).toThrow(RangeError);
    });
  });
});
