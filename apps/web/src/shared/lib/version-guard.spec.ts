import { describe, expect, it } from 'vitest';
import { applyTicketEvent, isNewer } from './version-guard';

describe('realtime version guard', () => {
  it('only accepts newer versions', () => {
    expect(isNewer(3, 2)).toBe(true);
    expect(isNewer(2, 2)).toBe(false);
    expect(isNewer(1, 2)).toBe(false);
    expect(isNewer(1, undefined)).toBe(true);
  });
  it('does not let a late stale event overwrite newer state, and adds unknown tickets', () => {
    const list = [
      { id: 'a', version: 5, status: 'open' },
      { id: 'b', version: 1, status: 'new' },
    ];
    expect(applyTicketEvent(list, { id: 'a', version: 4, status: 'new' })).toBe(list);
    expect(applyTicketEvent(list, { id: 'a', version: 6, status: 'resolved' })[0]?.status).toBe(
      'resolved',
    );
    expect(applyTicketEvent(list, { id: 'c', version: 1, status: 'new' })[0]?.id).toBe('c');
  });
});
