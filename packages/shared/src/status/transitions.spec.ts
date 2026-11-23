import { describe, expect, it } from 'vitest';
import { TICKET_STATUSES } from '../domain/constants';
import {
  allowedTargets,
  canTransition,
  pausesSla,
  TRANSITIONS,
  transitionsMarkdown,
  type Actor,
} from './transitions';

const ACTORS: readonly Actor[] = ['system', 'customer', 'agent', 'lead', 'admin'];

describe('status transitions', () => {
  it('has no duplicate (from,to) rows and no self transitions', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}>${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(TRANSITIONS.every((t) => t.from !== t.to)).toBe(true);
  });

  it('closed is terminal for everybody', () => {
    for (const to of TICKET_STATUSES)
      for (const a of ACTORS) expect(canTransition('closed', to, a)).toBe(false);
  });

  it('nobody can move a ticket to new', () => {
    for (const from of TICKET_STATUSES)
      for (const a of ACTORS) expect(canTransition(from, 'new', a)).toBe(false);
  });

  it('full matrix: allowed exactly as listed, for every pair and actor', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        for (const actor of ACTORS) {
          const listed = TRANSITIONS.some(
            (t) => t.from === from && t.to === to && t.actors.includes(actor),
          );
          expect(canTransition(from, to, actor), `${actor}: ${from} -> ${to}`).toBe(listed);
        }
      }
    }
  });

  it('agents cannot close; leads and admins can close only resolved tickets', () => {
    for (const from of TICKET_STATUSES) {
      expect(canTransition(from, 'closed', 'agent')).toBe(false);
      expect(canTransition(from, 'closed', 'customer')).toBe(false);
    }
    expect(canTransition('resolved', 'closed', 'lead')).toBe(true);
    expect(canTransition('resolved', 'closed', 'admin')).toBe(true);
    expect(canTransition('open', 'closed', 'lead')).toBe(false);
  });

  it('auto-close and merge are system-only paths', () => {
    expect(canTransition('resolved', 'closed', 'system')).toBe(true);
    for (const from of ['new', 'open', 'waiting_customer', 'on_hold'] as const) {
      expect(canTransition(from, 'closed', 'system')).toBe(true);
    }
  });

  it('customer replies can reopen resolved tickets and end the waiting pause, nothing else', () => {
    expect(canTransition('resolved', 'open', 'customer')).toBe(true);
    expect(canTransition('waiting_customer', 'open', 'customer')).toBe(true);
    expect(allowedTargets('open', 'customer')).toEqual([]);
    expect(allowedTargets('on_hold', 'customer')).toEqual([]);
  });

  it('only waiting_customer pauses the SLA', () => {
    expect(TICKET_STATUSES.filter(pausesSla)).toEqual(['waiting_customer']);
  });

  it('renders one markdown row per transition', () => {
    const md = transitionsMarkdown().split('\n');
    expect(md).toHaveLength(TRANSITIONS.length + 2);
  });
});
