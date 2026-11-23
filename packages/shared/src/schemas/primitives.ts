import { DateTime } from 'luxon';
import { z } from 'zod';
import { LANGUAGES, LIMITS, PRIORITIES, TICKET_STATUSES } from '../domain/constants';

/** Text without control characters other than tab and newline (no NUL, no ESC, no bare CR). */
const noBadControls = /^[^\x00-\x08\x0b-\x1f\x7f]*$/;

export const uuid = z.string().uuid();

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.emailMax)
  .email()
  .refine((v) => !/[\r\n]/.test(v), 'must not contain line breaks');

export const personName = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.nameMax)
  .regex(/^[^\x00-\x1f\x7f]*$/, 'must not contain control characters');

/** Single-line text (subjects, titles). */
export const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\x00-\x1f\x7f\u2028\u2029]*$/, 'must be a single line without control characters');

export const multiLineText = (max: number) =>
  z.string().min(1).max(max).regex(noBadControls, 'must not contain control characters');

export const language = z.enum(LANGUAGES);
export const priority = z.enum(PRIORITIES);
export const ticketStatus = z.enum(TICKET_STATUSES);

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => DateTime.fromISO(v, { zone: 'utc' }).isValid, 'not a real calendar date');

export const ianaZone = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => DateTime.local().setZone(v).isValid, 'unknown IANA time zone');

/** "HH:mm" local time of day, 00:00-23:59, or "24:00" for end of day. */
export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'expected HH:mm');

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(50),
  cursor: z.string().max(200).optional(),
});

export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const hhmmOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
