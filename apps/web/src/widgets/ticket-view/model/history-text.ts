import { PRIORITY_LABEL, STATUS_LABEL } from '@/entities/ticket';

export type HistoryEvent = {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
};

/** Names for the ids that appear in event data; an id that is not known is never shown, only a generic word. */
export type NameLookup = {
  readonly user: (id: string) => string | null;
  readonly team: (id: string) => string | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const status = (v: unknown): string => STATUS_LABEL[str(v) ?? ''] ?? 'another status';
const priority = (v: unknown): string => PRIORITY_LABEL[str(v) ?? ''] ?? 'another priority';
const target = (v: unknown): string => (v === 'first_response' ? 'first response' : 'resolution');

const REASONS: Readonly<Record<string, string>> = {
  agent_at_limit: 'the agent was at their ticket limit',
  left_shift: 'the agent went off shift',
  left_team: 'the agent left the team',
  deactivated: 'the agent was deactivated',
};

/** Turns a history event into one readable phrase (the actor is shown separately). No raw JSON and no ids. */
export const describeEvent = (e: HistoryEvent, names: NameLookup): string => {
  const d = e.data;
  const who = (v: unknown): string => {
    const id = str(v);
    return (id === null ? null : names.user(id)) ?? 'a colleague';
  };
  switch (e.type) {
    case 'created':
      return `created the ticket (${priority(d['priority']).toLowerCase()} priority${
        str(d['teamId']) !== null && names.team(str(d['teamId']) ?? '') !== null
          ? `, team ${names.team(str(d['teamId']) ?? '')}`
          : ''
      })`;
    case 'assigned':
      return `assigned the ticket to ${who(d['assigneeId'])}${d['auto'] === true ? ' automatically' : ''}`;
    case 'taken':
      return 'took the ticket';
    case 'transferred':
      return str(d['from']) === null
        ? `assigned the ticket to ${who(d['to'])}`
        : `transferred the ticket from ${who(d['from'])} to ${who(d['to'])}`;
    case 'returned_to_queue': {
      const reason = REASONS[str(d['reason']) ?? ''];
      return `returned the ticket to the team queue${reason === undefined ? '' : ` because ${reason}`}`;
    }
    case 'status_changed':
      return `changed the status from ${status(d['from'])} to ${status(d['to'])}`;
    case 'priority_changed':
      return `changed the priority from ${priority(d['from'])} to ${priority(d['to'])}`;
    case 'team_changed': {
      const from = names.team(str(d['from']) ?? '');
      const to = names.team(str(d['to']) ?? '');
      return `moved the ticket${from === null ? '' : ` from ${from}`}${to === null ? ' to another team' : ` to ${to}`}`;
    }
    case 'reply':
      return 'sent a reply to the customer';
    case 'reply_cancelled':
      return 'undid a reply before it was sent';
    case 'note':
      return 'added an internal note';
    case 'customer_reply':
      return 'wrote a reply';
    case 'reopened':
      return 'reopened the ticket';
    case 'merged':
      return `merged this ticket into #${num(d['intoNumber']) ?? '?'}`;
    case 'merged_in':
      return `merged ticket #${num(d['fromNumber']) ?? '?'} into this one`;
    case 'follow_up_created':
      return `opened follow-up ticket #${num(d['number']) ?? '?'}`;
    case 'survey_sent':
      return 'sent the satisfaction survey';
    case 'auto_reply_ignored':
      return `ignored an automatic ${str(d['kind']) === 'bounce' ? 'bounce' : 'reply'} message`;
    case 'sla_warning':
      return `warned that 80% of the ${target(d['target'])} time is used`;
    case 'sla_breach':
      return `recorded a missed ${target(d['target'])} deadline`;
    case 'email_failed':
      return `could not send an email${str(d['error']) === null ? '' : ` (${str(d['error'])})`}`;
    default:
      return e.type.replace(/_/g, ' ');
  }
};
