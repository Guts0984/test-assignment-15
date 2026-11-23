export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TICKET_STATUSES = [
  'new',
  'open',
  'waiting_customer',
  'on_hold',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses in which a ticket counts as "open" for agent load and queues. */
export const ACTIVE_STATUSES = ['new', 'open', 'waiting_customer', 'on_hold'] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export const isActiveStatus = (s: TicketStatus): s is ActiveStatus =>
  (ACTIVE_STATUSES as readonly string[]).includes(s);

export const LANGUAGES = ['en', 'uk', 'pl', 'de'] as const;
export type Language = (typeof LANGUAGES)[number];

export const USER_ROLES = ['admin', 'staff'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const MEMBERSHIP_ROLES = ['agent', 'lead'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MESSAGE_KINDS = ['public', 'note'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Limits shared by api, worker and web. */
export const LIMITS = {
  subjectMax: 300,
  bodyMax: 100_000,
  noteMax: 100_000,
  nameMax: 200,
  emailMax: 254,
  attachmentBytesMax: 10 * 1024 * 1024,
  attachmentNameMax: 255,
  attachmentsMaxCount: 20,
  searchQueryMax: 200,
  pageSizeMax: 100,
  keywordMax: 100,
  commentMax: 2000,
} as const;

export const TICKET_NUMBER_START = 100_000;
