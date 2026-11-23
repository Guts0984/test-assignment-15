import {
  collectorOf,
  flushCollector,
  inTx,
  requestTeamAssignments,
  returnAgentTicketsToQueue,
  type Db,
  type RealtimePublisher,
  type Tx,
} from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';

export type ShiftDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly replyWindowMinutes: number;
  readonly publisher: RealtimePublisher;
};

/**
 * Starting a shift makes the agent eligible and asks for an assignment run for every team.
 * Ending it returns tickets without a public reply in the last window to the team queue.
 */
export const createShifts = (d: ShiftDeps) => ({
  setShift: async (userId: string, onShift: boolean) => {
    const ref: { tx: Tx | null } = { tx: null };
    const result = await inTx(d.db, async (tx) => {
      ref.tx = tx;
      const now = d.clock.now();
      await tx.user.update({ where: { id: userId }, data: { onShift } });
      const teams = await tx.teamMember.findMany({ where: { userId }, select: { teamId: true } });
      const affected = new Set(teams.map((t) => t.teamId));
      let returned = 0;
      if (!onShift) {
        const since = new Date(now.getTime() - d.replyWindowMinutes * 60_000);
        const r = await returnAgentTicketsToQueue(tx, {
          agentId: userId,
          noReplySince: since,
          reason: 'shift_off',
          now,
        });
        returned = r.ticketIds.length;
      }
      await requestTeamAssignments(tx, [...affected], now);
      return { onShift, returnedTickets: returned };
    });
    if (ref.tx !== null)
      await flushCollector(d.db, collectorOf(ref.tx), d.publisher).catch(() => undefined);
    return result;
  },
});

export type ShiftUseCases = ReturnType<typeof createShifts>;
