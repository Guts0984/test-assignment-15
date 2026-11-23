/** Business errors raised by SQL triggers via RAISE EXCEPTION '<CODE>'. */
export const DB_ERROR_CODES = [
  'AGENT_AT_LIMIT',
  'TICKETS_NOT_MERGEABLE',
  'TICKET_ALREADY_MERGED',
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

const textOf = (e: unknown): string => {
  if (e instanceof Error) {
    const meta = (e as { meta?: unknown }).meta;
    return `${e.message} ${meta === undefined ? '' : JSON.stringify(meta)}`;
  }
  return String(e);
};

/** Finds a trigger-raised business error in a database failure, or null. */
export const dbBusinessError = (e: unknown): DbErrorCode | null => {
  const text = textOf(e);
  return DB_ERROR_CODES.find((c) => text.includes(c)) ?? null;
};

/** True for Postgres unique violations (Prisma P2002 or raw 23505). */
export const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: unknown })?.code;
  if (code === 'P2002') return true;
  return /23505|duplicate key value violates unique constraint|Unique constraint failed/i.test(
    textOf(e),
  );
};

export const isDeadlockOrSerialization = (e: unknown): boolean =>
  /40P01|40001|deadlock detected|could not serialize/i.test(textOf(e));
