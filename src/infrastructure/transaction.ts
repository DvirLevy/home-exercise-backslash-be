import type { Prisma, PrismaClient } from './prisma';

/**
 * Runs a unit of work atomically. `Ctx` is whatever the callback needs (typically repositories
 * bound to the transaction), so services never see Prisma. If the callback throws, everything rolls back.
 */
export interface TransactionRunner<Ctx> {
  run<T>(work: (ctx: Ctx) => Promise<T>): Promise<T>;
}

export interface PrismaTransactionOptions {
  /** Longest a transaction may run; large graph replaces insert many rows. */
  timeoutMs?: number;
  /** Longest a caller waits for a pooled connection before the transaction starts. */
  maxWaitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

export class PrismaTransactionRunner<Ctx> implements TransactionRunner<Ctx> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly createContext: (tx: Prisma.TransactionClient) => Ctx,
    private readonly options: PrismaTransactionOptions = {},
  ) {}

  run<T>(work: (ctx: Ctx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(this.createContext(tx)), {
      timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxWait: this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    });
  }
}
