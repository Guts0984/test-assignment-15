import type { TicketStatus } from '../domain/constants';

/** Who triggers a transition. `system` covers jobs and rule-driven changes (auto-close, merge). */
export type Actor = 'system' | 'customer' | 'agent' | 'lead' | 'admin';

export type Transition = {
  readonly from: TicketStatus;
  readonly to: TicketStatus;
  readonly actors: readonly Actor[];
  readonly note: string;
};

const STAFF: readonly Actor[] = ['agent', 'lead', 'admin'];
const MANAGERS: readonly Actor[] = ['lead', 'admin'];

/** The single source of truth for status changes; the README table is checked against it. */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: 'new',
    to: 'open',
    actors: ['system', ...STAFF],
    note: 'First public agent reply opens it; staff may open manually',
  },
  { from: 'new', to: 'waiting_customer', actors: STAFF, note: 'Manual' },
  { from: 'new', to: 'on_hold', actors: STAFF, note: 'Manual' },
  { from: 'new', to: 'resolved', actors: STAFF, note: 'Manual' },
  {
    from: 'open',
    to: 'waiting_customer',
    actors: STAFF,
    note: 'Manual; the resolution timer pauses',
  },
  { from: 'open', to: 'on_hold', actors: STAFF, note: 'Manual' },
  { from: 'open', to: 'resolved', actors: STAFF, note: 'Manual' },
  {
    from: 'waiting_customer',
    to: 'open',
    actors: ['system', 'customer', ...STAFF],
    note: 'Customer reply ends the pause; staff may resume manually',
  },
  { from: 'waiting_customer', to: 'on_hold', actors: STAFF, note: 'Manual; the pause ends' },
  { from: 'waiting_customer', to: 'resolved', actors: STAFF, note: 'Manual; the pause ends' },
  { from: 'on_hold', to: 'open', actors: STAFF, note: 'Manual' },
  {
    from: 'on_hold',
    to: 'waiting_customer',
    actors: STAFF,
    note: 'Manual; the resolution timer pauses',
  },
  { from: 'on_hold', to: 'resolved', actors: STAFF, note: 'Manual' },
  {
    from: 'resolved',
    to: 'open',
    actors: ['system', 'customer', ...STAFF],
    note: 'Customer reply reopens; staff may reopen manually',
  },
  {
    from: 'resolved',
    to: 'closed',
    actors: ['system', ...MANAGERS],
    note: 'Auto-close after 72 h without a customer reply; leads and admins may close manually',
  },
  {
    from: 'new',
    to: 'closed',
    actors: ['system'],
    note: 'Ticket merged into another one (duplicate)',
  },
  {
    from: 'open',
    to: 'closed',
    actors: ['system'],
    note: 'Ticket merged into another one (duplicate)',
  },
  {
    from: 'waiting_customer',
    to: 'closed',
    actors: ['system'],
    note: 'Ticket merged into another one (duplicate)',
  },
  {
    from: 'on_hold',
    to: 'closed',
    actors: ['system'],
    note: 'Ticket merged into another one (duplicate)',
  },
];

export const canTransition = (from: TicketStatus, to: TicketStatus, actor: Actor): boolean =>
  TRANSITIONS.some((t) => t.from === from && t.to === to && t.actors.includes(actor));

/** Statuses a given actor may move a ticket to from `from`. */
export const allowedTargets = (from: TicketStatus, actor: Actor): readonly TicketStatus[] =>
  TRANSITIONS.filter((t) => t.from === from && t.actors.includes(actor)).map((t) => t.to);

/** True when entering this status starts an SLA pause. */
export const pausesSla = (status: TicketStatus): boolean => status === 'waiting_customer';

/** Renders the transition table as markdown; the README embeds exactly this text. */
export const transitionsMarkdown = (): string => {
  const rows = TRANSITIONS.map(
    (t) => `| \`${t.from}\` | \`${t.to}\` | ${t.actors.join(', ')} | ${t.note} |`,
  );
  return ['| From | To | Who | Notes |', '| --- | --- | --- | --- |', ...rows].join('\n');
};
