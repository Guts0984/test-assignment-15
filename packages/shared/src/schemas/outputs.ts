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
