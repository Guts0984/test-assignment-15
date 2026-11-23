/** The one error body every endpoint returns (see the OpenAPI ErrorResponse). */
export type ApiErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly {
      readonly path: readonly (string | number)[];
      readonly message: string;
    }[];
    readonly data?: Record<string, unknown>;
  };
};

export const isApiError = (v: unknown): v is ApiErrorBody =>
  typeof v === 'object' &&
  v !== null &&
  'error' in v &&
  typeof (v as ApiErrorBody).error?.code === 'string';

export type FieldError = { readonly field: string; readonly message: string };

/** Server field errors -> form fields. Paths not in `known` become form-level errors so nothing is silently lost. */
export const toFieldErrors = (
  body: unknown,
  known: readonly string[],
): { fields: FieldError[]; form: string | null } => {
  if (!isApiError(body)) return { fields: [], form: 'Something went wrong. Please try again.' };
  const fields: FieldError[] = [];
  const unmatched: string[] = [];
  for (const d of body.error.details ?? []) {
    const field = String(d.path[0] ?? '');
    if (known.includes(field)) fields.push({ field, message: d.message });
    else unmatched.push(d.message);
  }
  const form =
    fields.length > 0 && unmatched.length === 0 ? null : (unmatched[0] ?? body.error.message);
  return {
    fields,
    form:
      body.error.code === 'VALIDATION_FAILED' && fields.length > 0 && unmatched.length === 0
        ? null
        : form,
  };
};

/** Friendly texts for the stable error codes. */
export const messageForCode = (code: string, fallback: string): string =>
  (
    ({
      TICKET_HAS_NEW_MESSAGES: 'The ticket has new messages. Review them before sending.',
      UNDO_WINDOW_EXPIRED: 'It is too late to undo: the email has been sent.',
      AGENT_AT_LIMIT: 'That agent has reached their ticket limit.',
      TICKET_ALREADY_ASSIGNED: 'Someone else already owns this ticket.',
      INVALID_STATUS_TRANSITION: 'That status change is not allowed.',
      TICKETS_NOT_MERGEABLE: 'These tickets cannot be merged (different customers or closed).',
      TICKET_ALREADY_MERGED: 'A merged ticket cannot be merged again.',
      LINK_EXPIRED: 'This link has expired.',
      LINK_REVOKED: 'This link is no longer valid because the ticket was merged.',
      LINK_INVALID: 'This link is not valid.',
      SURVEY_EXPIRED: 'This survey link has expired.',
      INVALID_CREDENTIALS: 'Invalid email or password.',
      FORBIDDEN: 'You are not allowed to do that.',
      NOT_FOUND: 'Not found.',
      PAYLOAD_TOO_LARGE: 'The files are too large (10 MB in total).',
    }) as Record<string, string>
  )[code] ?? fallback;
