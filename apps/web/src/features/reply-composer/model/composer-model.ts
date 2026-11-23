import type { StaffMessage } from '@/shared/api';

/** Highest public (customer-visible), not-undone message sequence: what the agent has "seen" when they start typing. */
export const lastPublicSeq = (messages: readonly StaffMessage[]): number =>
  messages.reduce(
    (max, m) => (m.kind === 'public' && m.cancelledAt === null && m.seq > max ? m.seq : max),
    0,
  );

export type ConflictMessage = {
  readonly id: string;
  readonly seq: number;
  readonly body: string;
  readonly authorKind: string;
};

export const parseConflict = (
  data: unknown,
): { messages: ConflictMessage[]; latestSeq: number } | null => {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as { messages?: unknown; latestSeq?: unknown };
  if (!Array.isArray(d.messages) || typeof d.latestSeq !== 'number') return null;
  return { messages: d.messages as ConflictMessage[], latestSeq: d.latestSeq };
};

/** Seconds left in the undo window by the server clock (never below zero). */
export const undoSecondsLeft = (sendAfterIso: string, serverNowMs: number): number =>
  Math.max(0, Math.ceil((Date.parse(sendAfterIso) - serverNowMs) / 1000));
