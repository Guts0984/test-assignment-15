import type { TicketListItem } from '@/shared/api';

export const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  open: 'Open',
  waiting_customer: 'Waiting for customer',
  on_hold: 'On hold',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const STATUS_TONE: Record<string, 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  new: 'blue',
  open: 'green',
  waiting_customer: 'amber',
  on_hold: 'gray',
  resolved: 'green',
  closed: 'gray',
};
export const PRIORITY_TONE: Record<string, 'gray' | 'blue' | 'green' | 'amber' | 'red'> = {
  urgent: 'red',
  high: 'amber',
  normal: 'gray',
  low: 'gray',
};

/** Statuses a person may choose from the status menu (the server enforces the real transition table). */
export const MANUAL_STATUSES = ['open', 'waiting_customer', 'on_hold', 'resolved'] as const;

/** The deadline the ticket is currently counting down to, with a label. */
export const currentDeadline = (t: TicketListItem): { label: string; at: string } | null => {
  if (t.status === 'closed' || t.status === 'resolved') return null;
  if (t.firstRespondedAt === null)
    return t.firstResponseDueAt === null
      ? null
      : { label: 'First response', at: t.firstResponseDueAt };
  if (t.slaPaused || t.resolutionDueAt === null) return null;
  return { label: 'Resolution', at: t.resolutionDueAt };
};

/** Queues are ordered by deadline; tickets without one go last. */
export const byDeadline = (a: TicketListItem, b: TicketListItem): number =>
  (a.nextDueAt === null ? Infinity : Date.parse(a.nextDueAt)) -
  (b.nextDueAt === null ? Infinity : Date.parse(b.nextDueAt));
