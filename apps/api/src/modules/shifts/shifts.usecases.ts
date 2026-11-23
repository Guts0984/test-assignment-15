import { inTx, requestTeamAssignments, returnAgentTicketsToQueue, type Db } from '@helpdesk/core';
import type { Clock } from '@helpdesk/shared';

export type ShiftDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly replyWindowMinutes: number;
};

/**
 * Starting a shift makes the agent eligible and asks for an assignment run for every team.
 * Ending it returns tickets without a public reply in the last window to the team queue.
 */
export const createShifts = (d: ShiftDeps) => ({
  setShift: (userId: string, onShift: boolean) =>
    inTx(d.db, async (tx) => {
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
    }),
});

export type ShiftUseCases = ReturnType<typeof createShifts>;
