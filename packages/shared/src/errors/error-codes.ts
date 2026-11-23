import { z } from 'zod';

/** Stable machine-readable error codes. Every API error carries exactly one of them. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATUS_TRANSITION',
  'AGENT_AT_LIMIT',
  'TICKET_ALREADY_ASSIGNED',
  'TICKET_HAS_NEW_MESSAGES',
  'UNDO_WINDOW_EXPIRED',
  'TICKETS_NOT_MERGEABLE',
  'TICKET_ALREADY_MERGED',
  'LINK_INVALID',
  'LINK_EXPIRED',
  'LINK_REVOKED',
  'SURVEY_EXPIRED',
  'INBOUND_SIGNATURE_INVALID',
  'MAIL_UNPARSEABLE',
  'EVENT_BUDGET_EXCEEDED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  MALFORMED_JSON: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATUS_TRANSITION: 409,
  AGENT_AT_LIMIT: 409,
  TICKET_ALREADY_ASSIGNED: 409,
  TICKET_HAS_NEW_MESSAGES: 409,
  UNDO_WINDOW_EXPIRED: 409,
  TICKETS_NOT_MERGEABLE: 409,
  TICKET_ALREADY_MERGED: 409,
  LINK_INVALID: 401,
  LINK_EXPIRED: 410,
  LINK_REVOKED: 410,
  SURVEY_EXPIRED: 410,
  INBOUND_SIGNATURE_INVALID: 401,
  MAIL_UNPARSEABLE: 422,
  EVENT_BUDGET_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export const errorDetailSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  code: z.string(),
  message: z.string(),
});

/** The one error body shape used by every endpoint. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    /** Machine-readable extras for specific codes, e.g. the new messages behind TICKET_HAS_NEW_MESSAGES. */
    data: z.record(z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
