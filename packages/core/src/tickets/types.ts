import type { Actor, ErrorCode } from '@helpdesk/shared';
import type { Tx } from '../db/client';

/** Settings the ticket use-cases need; the apps fill them from their env. */
export type TicketConfig = {
  readonly warningRatio: number;
  readonly undoSeconds: number;
  readonly linkTtlDays: number;
  readonly surveyTtlDays: number;
  readonly autoCloseHours: number;
  readonly mailDomain: string;
  readonly publicBaseUrl: string;
  readonly maxAttachmentBytes: number;
};

export type Ctx = { readonly tx: Tx; readonly now: Date; readonly cfg: TicketConfig };

export type ActorRef = { readonly kind: Actor; readonly userId: string | null };

/** Expected failure of a ticket operation; `code` is an API error code. */
export type TicketError = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly data?: unknown;
};

export const fail = (
  code: ErrorCode,
  message: string,
  data?: unknown,
): { readonly ok: false; readonly error: TicketError } => ({
  ok: false,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export type TicketRow = {
  readonly id: string;
  readonly number: number;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly language: string;
  readonly teamId: string;
  readonly customerId: string;
  readonly assigneeId: string | null;
  readonly mergedIntoId: string | null;
  readonly followUpOfId: string | null;
  readonly version: number;
  readonly messageSeq: number;
  readonly createdAt: Date;
  readonly firstRespondedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly mailboxAddress: string | null;
};

export type AttachmentInput = {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
};
