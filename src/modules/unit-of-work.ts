import type { PrismaClient } from '../infrastructure/prisma';
import { PrismaTransactionRunner, type PrismaTransactionOptions, type TransactionRunner } from '../infrastructure/transaction';
import type { FilterRepository } from './filters/filter.repository';
import { PrismaFilterRepository } from './filters/prisma-filter.repository';
import type { GraphRepository } from './graphs/graph.repository';
import { PrismaGraphRepository } from './graphs/prisma-graph.repository';

/** The repositories a write transaction can use; every one of them shares the same transaction. */
export interface TransactionalRepositories {
  graphs: GraphRepository;
  filters: FilterRepository;
}

export type UnitOfWork = TransactionRunner<TransactionalRepositories>;

export function createPrismaUnitOfWork(prisma: PrismaClient, options?: PrismaTransactionOptions): UnitOfWork {
  return new PrismaTransactionRunner<TransactionalRepositories>(
    prisma,
    (tx) => ({ graphs: new PrismaGraphRepository(tx), filters: new PrismaFilterRepository(tx) }),
    options,
  );
}
