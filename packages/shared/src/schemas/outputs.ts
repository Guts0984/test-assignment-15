import { z } from 'zod';
import { MEMBERSHIP_ROLES, USER_ROLES } from '../domain/constants';
import { language, priority, ticketStatus } from './primitives';

const isoDateTime = z.string().datetime();

export const membershipView = z.object({
  teamId: z.string().uuid(),
  role: z.enum(MEMBERSHIP_ROLES),
});

export const userView = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(USER_ROLES),
  onShift: z.boolean(),
  ticketLimit: z.number().int(),
  languages: z.array(language),
  memberships: z.array(membershipView),
});

export const authResponse = z.object({
  accessToken: z.string(),
  expiresInSeconds: z.number().int(),
  user: userView,
});

export const okResponse = z.object({ ok: z.literal(true) });

export const timeResponse = z.object({ now: isoDateTime });

export const teamView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  timeZone: z.string(),
  workdays: z.array(z.number().int()),
  workStart: z.string(),
  workEnd: z.string(),
  defaultLanguage: language,
});

export const holidayView = z.object({
  id: z.string().uuid(),
  date: z.string(),
  name: z.string(),
});

export const agentView = userView.extend({
  active: z.boolean(),
  openCount: z.number().int(),
});

export const routingRuleView = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  enabled: z.boolean(),
  recipient: z.string().nullable(),
  subjectKeywords: z.array(z.string()),
  language: language.nullable(),
  teamId: z.string().uuid(),
  priority: priority.nullable(),
});

export const mailboxView = z.object({ address: z.string(), defaultTeamId: z.string().uuid() });

export const failedJobView = z.object({
  id: z.string(),
  kind: z.string(),
  ref: z.string(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  lastError: z.string().nullable(),
  runAt: isoDateTime,
  createdAt: isoDateTime,
});

export const ticketStatusView = ticketStatus;
export type UserView = z.infer<typeof userView>;
export type TeamView = z.infer<typeof teamView>;
export type AgentView = z.infer<typeof agentView>;

const dt = z.string().datetime();
const dtNull = dt.nullable();

export const ticketListItem = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  subject: z.string(),
  status: ticketStatus,
  priority,
  language,
  teamId: z.string().uuid(),
  assigneeId: z.string().uuid().nullable(),
  assigneeName: z.string().nullable(),
  customerName: z.string(),
  customerEmail: z.string(),
  createdAt: dt,
  updatedAt: dt,
  nextDueAt: dtNull,
  firstResponseDueAt: dtNull,
  resolutionDueAt: dtNull,
  slaPaused: z.boolean(),
  firstRespondedAt: dtNull,
  firstResponseBreached: z.boolean(),
  resolutionBreached: z.boolean(),
  version: z.number().int(),
});

export const ticketList = z.object({
  items: z.array(ticketListItem),
  serverTime: dt,
  nextCursor: z.string().nullable(),
});

export const attachmentView = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int(),
});

export const staffMessageView = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  kind: z.enum(['public', 'note']),
  direction: z.enum(['inbound', 'outbound', 'internal']),
  authorKind: z.enum(['customer', 'agent', 'system']),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: dt,
  releasedAt: dtNull,
  cancelledAt: dtNull,
  /** For a scheduled reply: the instant after which undo is no longer possible. */
  sendAfter: dtNull,
  sendState: z.string().nullable(),
  autoKind: z.enum(['autoreply', 'bounce']).nullable(),
  originTicketId: z.string().uuid().nullable(),
  attachments: z.array(attachmentView),
});

export const ticketEventView = z.object({
  id: z.string(),
  type: z.string(),
  actorKind: z.string(),
  actorName: z.string().nullable(),
  data: z.record(z.unknown()),
  createdAt: dt,
});

export const ticketDetail = z.object({
  ticket: ticketListItem.extend({
    customerId: z.string().uuid(),
    mergedIntoId: z.string().uuid().nullable(),
    mergedIntoNumber: z.number().int().nullable(),
    followUpOfId: z.string().uuid().nullable(),
    followUpOfNumber: z.number().int().nullable(),
    resolvedAt: dtNull,
    closedAt: dtNull,
    messageSeq: z.number().int(),
  }),
  messages: z.array(staffMessageView),
  events: z.array(ticketEventView),
  serverTime: dt,
});

export const replyCreated = z.object({
  messageId: z.string().uuid(),
  seq: z.number().int(),
  sendAfter: dt,
  serverTime: dt,
});

export const replyConflict = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      seq: z.number().int(),
      body: z.string(),
      authorKind: z.string(),
      createdAt: z.string(),
    }),
  ),
  latestSeq: z.number().int(),
});

export const noteCreated = z.object({ messageId: z.string().uuid(), seq: z.number().int() });

export const searchResultItem = ticketListItem.extend({ snippet: z.string().nullable() });
export const searchResults = z.object({
  items: z.array(searchResultItem),
  serverTime: dt,
  nextCursor: z.string().nullable(),
});

export const dashboardView = z.object({
  teamId: z.string().uuid(),
  serverTime: dt,
  agents: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      onShift: z.boolean(),
      openCount: z.number().int(),
      ticketLimit: z.number().int(),
    }),
  ),
  unassignedCount: z.number().int(),
  unassigned: z.array(ticketListItem),
  atRisk: z.array(ticketListItem),
  overdue: z.array(ticketListItem),
});

const stats = z.object({
  tickets: z.number().int(),
  firstResponseMedianMinutes: z.number().nullable(),
  firstResponseP90Minutes: z.number().nullable(),
  resolutionMedianMinutes: z.number().nullable(),
  resolutionP90Minutes: z.number().nullable(),
  withinSlaPercent: z.number().nullable(),
  breaches: z.number().int(),
  ratingAverage: z.number().nullable(),
  ratingCount: z.number().int(),
});

export const reportView = z.object({
  from: z.string(),
  to: z.string(),
  total: stats,
  byTeam: z.array(stats.extend({ teamId: z.string().uuid(), teamName: z.string() })),
  byAgent: z.array(stats.extend({ agentId: z.string().uuid().nullable(), agentName: z.string() })),
  ratingDistribution: z.array(z.object({ rating: z.number().int(), count: z.number().int() })),
});

export const publicTicketCreated = z.object({ number: z.number().int(), message: z.string() });

export const portalTicketView = z.object({
  number: z.number().int(),
  subject: z.string(),
  status: ticketStatus,
  canReply: z.boolean(),
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      direction: z.enum(['inbound', 'outbound']),
      authorName: z.string().nullable(),
      body: z.string(),
      createdAt: dt,
      attachments: z.array(attachmentView),
    }),
  ),
  serverTime: dt,
});

export const portalReplyResult = z.object({ number: z.number().int(), newRequest: z.boolean() });

export const surveyView = z.object({
  ticketNumber: z.number().int(),
  subject: z.string(),
  rating: z.number().int().nullable(),
  comment: z.string().nullable(),
  expiresAt: dt,
});

export const inboundAccepted = z.object({ status: z.enum(['queued', 'duplicate']) });

export const notificationView = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  ticketId: z.string().uuid().nullable(),
  data: z.record(z.unknown()),
  createdAt: dt,
  read: z.boolean(),
});
export const notificationList = z.object({
  items: z.array(notificationView),
  unread: z.number().int(),
});
