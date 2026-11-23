import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../../src/index';

let shared: Db | null = null;

export const testDb = (): Db => {
  if (shared === null) {
    const url = process.env.TEST_DATABASE_URL;
    if (url === undefined) throw new Error('TEST_DATABASE_URL is not set');
    // Bursts of 500 concurrent operations queue for the small pool; give them time instead of failing on a busy machine.
    shared = createDb(`${url}${url.includes('?') ? '&' : '?'}pool_timeout=60`);
  }
  return shared;
};

export const uniq = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`;

export const createTeam = async (
  db: Db,
  over: { timeZone?: string } = {},
): Promise<{ id: string }> =>
  db.team.create({
    data: {
      name: uniq('team'),
      timeZone: over.timeZone ?? 'Europe/Kyiv',
      workdays: [1, 2, 3, 4, 5],
      workStartMin: 540,
      workEndMin: 1080,
    },
    select: { id: true },
  });

export const createAgent = async (
  db: Db,
  teamId: string,
  over: { limit?: number; onShift?: boolean; role?: 'agent' | 'lead' } = {},
): Promise<{ id: string }> => {
  const u = await db.user.create({
    data: {
      email: `${uniq('agent')}@test.example`,
      name: 'Test Agent',
      passwordHash: 'x',
      ticketLimit: over.limit ?? 20,
      onShift: over.onShift ?? true,
      memberships: { create: { teamId, role: over.role ?? 'agent' } },
    },
    select: { id: true },
  });
  return u;
};

export const createCustomer = async (db: Db): Promise<{ id: string }> =>
  db.customer.create({
    data: { email: `${uniq('cust')}@test.example`, name: 'Test Customer' },
    select: { id: true },
  });

export const createTicket = async (
  db: Db,
  o: { teamId: string; customerId: string; assigneeId?: string; status?: string; subject?: string },
): Promise<{ id: string }> =>
  db.ticket.create({
    data: {
      teamId: o.teamId,
      customerId: o.customerId,
      assigneeId: o.assigneeId ?? null,
      status: o.status ?? 'new',
      subject: o.subject ?? 'Test subject',
    },
    select: { id: true },
  });

export const openCountOf = async (db: Db, userId: string): Promise<number> =>
  (await db.user.findUniqueOrThrow({ where: { id: userId }, select: { openCount: true } }))
    .openCount;

export const realLoadOf = async (db: Db, userId: string): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM tickets
    WHERE assignee_id = ${userId}::uuid AND status IN ('new','open','waiting_customer','on_hold')`;
  return Number(rows[0]?.n ?? 0n);
};
