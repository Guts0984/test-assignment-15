import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
/** Anything that can run queries: the client itself or a transaction. */
export type Queryable = Db | Tx;

export const createDb = (url: string, options: { readonly log?: boolean } = {}): Db =>
  new PrismaClient({
    datasources: { db: { url } },
    log: options.log === true ? ['warn', 'error'] : [],
  });

export type TxOptions = {
  readonly maxWaitMs?: number;
  readonly timeoutMs?: number;
  readonly isolation?: 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
};

/** Runs `fn` in one transaction (READ COMMITTED by default). */
export const inTx = <T>(db: Db, fn: (tx: Tx) => Promise<T>, o: TxOptions = {}): Promise<T> =>
  db.$transaction(fn, {
    maxWait: o.maxWaitMs ?? 10_000,
    timeout: o.timeoutMs ?? 30_000,
    isolationLevel: o.isolation ?? 'ReadCommitted',
  });

export { Prisma };
