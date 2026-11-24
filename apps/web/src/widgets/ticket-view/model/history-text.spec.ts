import { describe, expect, it } from 'vitest';
import { describeEvent, type NameLookup } from './history-text';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const names: NameLookup = {
  user: (id) => (id === ID ? 'Ann Agent' : null),
  team: (id) => (id === ID ? 'Billing' : null),
};

describe('describeEvent', () => {
  it('shows names, never ids or JSON', () => {
    const texts = [
      describeEvent({ type: 'assigned', data: { assigneeId: ID, auto: true } }, names),
      describeEvent(
        { type: 'transferred', data: { from: ID, to: 'ffffffff-4f89-41d3-9a0c-0305e82c3301' } },
        names,
      ),
      describeEvent(
        { type: 'team_changed', data: { from: ID, to: 'ffffffff-4f89-41d3-9a0c-0305e82c3301' } },
        names,
      ),
      describeEvent(
        { type: 'returned_to_queue', data: { fromAgentId: ID, reason: 'agent_at_limit' } },
        names,
      ),
      describeEvent({ type: 'something_new', data: { id: ID } }, names),
    ];
    expect(texts).toEqual([
      'assigned the ticket to Ann Agent automatically',
      'transferred the ticket from Ann Agent to a colleague',
      'moved the ticket from Billing to another team',
      'returned the ticket to the team queue because the agent was at their ticket limit',
      'something new',
    ]);
    for (const t of texts) expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|[{}"]/);
  });

  it('describes status, priority, merges and SLA events in words', () => {
    expect(
      describeEvent({ type: 'status_changed', data: { from: 'open', to: 'resolved' } }, names),
    ).toMatch(/from .+ to .+/);
    expect(
      describeEvent(
        { type: 'merged', data: { intoTicketId: ID, intoNumber: 100123, movedMessages: 2 } },
        names,
      ),
    ).toBe('merged this ticket into #100123');
    expect(
      describeEvent({ type: 'merged_in', data: { fromTicketId: ID, fromNumber: 100124 } }, names),
    ).toBe('merged ticket #100124 into this one');
    expect(describeEvent({ type: 'sla_breach', data: { target: 'first_response' } }, names)).toBe(
      'recorded a missed first response deadline',
    );
    expect(
      describeEvent({ type: 'created', data: { priority: 'urgent', teamId: ID } }, names),
    ).toContain('team Billing');
  });
});
