import { createPrismaClient, disconnectPrisma, getPrismaClient } from '../../../src/infrastructure/prisma';

const URL_A = 'postgresql://user:pass@localhost:5432/one';
const URL_B = 'postgresql://user:pass@localhost:5432/two';

// Creating a client does not connect: it only prepares a pool, so no database is needed here.
describe('the process-wide PrismaClient', () => {
  afterEach(async () => {
    await disconnectPrisma();
  });

  it('is created once and shared by every caller', () => {
    const first = getPrismaClient(URL_A);
    const second = getPrismaClient(URL_A);
    const third = getPrismaClient(URL_A);

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('refuses a second client for a different database instead of quietly opening another pool', () => {
    getPrismaClient(URL_A);

    expect(() => getPrismaClient(URL_B)).toThrow(/different DATABASE_URL/);
  });

  it('starts fresh after it has been disconnected', async () => {
    const before = getPrismaClient(URL_A);

    await disconnectPrisma();
    const after = getPrismaClient(URL_B); // a new process-wide client may now point elsewhere

    expect(after).not.toBe(before);
    expect(getPrismaClient(URL_B)).toBe(after);
  });

  it('can be disconnected twice, or before it was ever created', async () => {
    await expect(disconnectPrisma()).resolves.toBeUndefined();
    getPrismaClient(URL_A);

    await disconnectPrisma();
    await expect(disconnectPrisma()).resolves.toBeUndefined();
  });

  it('is not what createPrismaClient returns: that factory always builds a new, separate client (for tests)', () => {
    const shared = getPrismaClient(URL_A);

    expect(createPrismaClient(URL_A)).not.toBe(shared);
    expect(createPrismaClient(URL_A)).not.toBe(createPrismaClient(URL_A));
  });
});
