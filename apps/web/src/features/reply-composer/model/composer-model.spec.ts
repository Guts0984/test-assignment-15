import { describe, expect, it } from 'vitest';
import type { StaffMessage } from '@/shared/api';
import { lastPublicSeq, parseConflict, undoSecondsLeft } from './composer-model';

const m = (seq: number, over: Partial<StaffMessage>): StaffMessage =>
  ({
    id: String(seq),
    seq,
    kind: 'public',
    direction: 'inbound',
    authorKind: 'customer',
    authorName: null,
    body: 'x',
    createdAt: '',
    releasedAt: null,
    cancelledAt: null,
    sendAfter: null,
    sendState: null,
    autoKind: null,
    originTicketId: null,
    attachments: [],
    ...over,
  }) as StaffMessage;

describe('composer model', () => {
  it('ignores internal notes and undone replies when working out what the agent has seen', () => {
    expect(
      lastPublicSeq([
        m(1, {}),
        m(2, { kind: 'note' }),
        m(3, { cancelledAt: '2026-01-01T00:00:00Z' }),
        m(4, {}),
      ]),
    ).toBe(4);
    expect(lastPublicSeq([m(1, {}), m(2, { kind: 'note' }), m(3, { cancelledAt: 'x' })])).toBe(1);
    expect(lastPublicSeq([])).toBe(0);
  });
  it('parses the conflict payload defensively', () => {
    expect(
      parseConflict({
        messages: [{ id: 'a', seq: 2, body: 'hi', authorKind: 'agent' }],
        latestSeq: 2,
      })?.latestSeq,
    ).toBe(2);
    expect(parseConflict({ latestSeq: 'x' })).toBeNull();
    expect(parseConflict(undefined)).toBeNull();
  });
  it('counts the undo window down by the server clock and stops at zero', () => {
    const after = '2026-03-01T10:00:10.000Z';
    expect(undoSecondsLeft(after, Date.parse('2026-03-01T10:00:00.000Z'))).toBe(10);
    expect(undoSecondsLeft(after, Date.parse('2026-03-01T10:00:09.100Z'))).toBe(1);
    expect(undoSecondsLeft(after, Date.parse('2026-03-01T10:00:12.000Z'))).toBe(0);
  });
});
