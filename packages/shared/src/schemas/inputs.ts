import { z } from 'zod';
import { LIMITS, MEMBERSHIP_ROLES } from '../domain/constants';
import {
  email,
  ianaZone,
  isoDate,
  language,
  minutesOf,
  multiLineText,
  pagination,
  personName,
  priority,
  singleLine,
  ticketStatus,
  timeOfDay,
  uuid,
} from './primitives';

export const loginInput = z.object({ email, password: z.string().min(1).max(200) }).strict();

export const publicTicketInput = z
  .object({
    email,
    name: personName,
    subject: singleLine(LIMITS.subjectMax),
    body: multiLineText(LIMITS.bodyMax),
    language: language.optional(),
    idempotencyKey: z
      .string()
      .min(8)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const replyInput = z
  .object({
    body: multiLineText(LIMITS.bodyMax),
    /** Highest public message seq the agent has seen; guards against concurrent replies. */
    lastSeenSeq: z.number().int().min(0),
    /** Highest message seq the agent saw in the "new messages" warning and chose to send past; later messages still need a new confirmation. */
    confirmedSeq: z.number().int().min(0).nullish(),
  })
  .strict();

export const noteInput = z.object({ body: multiLineText(LIMITS.noteMax) }).strict();
export const portalReplyInput = z.object({ body: multiLineText(LIMITS.bodyMax) }).strict();

export const statusChangeInput = z.object({ status: ticketStatus }).strict();
export const priorityChangeInput = z.object({ priority }).strict();
export const teamChangeInput = z.object({ teamId: uuid }).strict();
export const transferInput = z.object({ assigneeId: uuid }).strict();
export const mergeInput = z.object({ targetTicketId: uuid }).strict();
export const shiftInput = z.object({ onShift: z.boolean() }).strict();

export const searchQueryInput = pagination
  .extend({ q: z.string().trim().min(1).max(LIMITS.searchQueryMax) })
  .strict();

export const queueQueryInput = pagination.extend({ teamId: uuid.optional() }).strict();

export const surveyRatingInput = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z
      .string()
      .max(LIMITS.commentMax)
      .regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/)
      .optional(),
  })
  .strict();

export const reportQueryInput = z
  .object({
    from: isoDate,
    to: isoDate,
    teamId: uuid.optional(),
    agentId: uuid.optional(),
    priority: priority.optional(),
  })
  .strict()
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'must not be before "from"' })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, {
    path: ['to'],
    message: 'a report covers at most 366 days',
  });

const hoursShape = {
  timeZone: ianaZone,
  workdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  workStart: timeOfDay,
  workEnd: timeOfDay,
};

const hoursRefine = (v: { workStart: string; workEnd: string }): boolean =>
  minutesOf(v.workEnd) > minutesOf(v.workStart);

export const teamInput = z
  .object({
    name: personName,
    defaultLanguage: language,
    ...hoursShape,
  })
  .strict()
  .refine(hoursRefine, { path: ['workEnd'], message: 'must be after workStart' });

export const teamHoursInput = z
  .object(hoursShape)
  .strict()
  .refine(hoursRefine, { path: ['workEnd'], message: 'must be after workStart' });

export const holidayInput = z.object({ date: isoDate, name: singleLine(LIMITS.nameMax) }).strict();

const membership = z.object({ teamId: uuid, role: z.enum(MEMBERSHIP_ROLES) }).strict();

export const agentInput = z
  .object({
    email,
    name: personName,
    password: z.string().min(8).max(200).optional(),
    ticketLimit: z.number().int().min(0).max(500),
    languages: z.array(language).min(1).max(4),
    memberships: z.array(membership).max(20),
    active: z.boolean().default(true),
  })
  .strict();

export const agentLimitInput = z
  .object({
    ticketLimit: z.number().int().min(0).max(500),
    languages: z.array(language).min(1).max(4).optional(),
  })
  .strict();

export const routingRuleInput = z
  .object({
    position: z.number().int().min(0).max(10_000),
    enabled: z.boolean().default(true),
    recipient: email.nullable().default(null),
    subjectKeywords: z.array(singleLine(LIMITS.keywordMax)).max(50).default([]),
    language: language.nullable().default(null),
    teamId: uuid,
    priority: priority.nullable().default(null),
  })
  .strict()
  .refine((v) => v.recipient !== null || v.subjectKeywords.length > 0 || v.language !== null, {
    path: ['recipient'],
    message: 'a rule needs at least one condition (recipient, subject keywords or language)',
  });

export const mailboxInput = z.object({ address: email, defaultTeamId: uuid }).strict();

export type LoginInput = z.infer<typeof loginInput>;
export type PublicTicketInput = z.infer<typeof publicTicketInput>;
export type ReplyInput = z.infer<typeof replyInput>;
export type NoteInput = z.infer<typeof noteInput>;
export type TeamInput = z.infer<typeof teamInput>;
export type AgentInput = z.infer<typeof agentInput>;
export type RoutingRuleInput = z.infer<typeof routingRuleInput>;
export type ReportQueryInput = z.infer<typeof reportQueryInput>;
export type SurveyRatingInput = z.infer<typeof surveyRatingInput>;

export const idParam = z.object({ id: uuid }).strict();
export const teamHolidayParams = z.object({ id: uuid, holidayId: uuid }).strict();
export const testClockInput = z
  .object({
    offsetMs: z
      .number()
      .int()
      .min(-10 * 365 * 86_400_000)
      .max(10 * 365 * 86_400_000)
      .optional(),
    advanceMs: z
      .number()
      .int()
      .min(0)
      .max(10 * 365 * 86_400_000)
      .optional(),
  })
  .strict()
  .refine((v) => (v.offsetMs === undefined) !== (v.advanceMs === undefined), {
    message: 'send exactly one of offsetMs or advanceMs',
  });

export const jobIdParam = z
  .object({ id: z.string().regex(/^\d{1,18}$/, 'must be a numeric job id') })
  .strict();

export const replyIdParams = z.object({ id: uuid, messageId: uuid }).strict();
export const attachmentIdParam = z.object({ id: uuid }).strict();
export const dashboardParams = z.object({ teamId: uuid }).strict();
export const queueQuery = z
  .object({ teamId: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .strict();
