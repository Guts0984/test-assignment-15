import { LIMITS, type ErrorResponse } from '@helpdesk/shared';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { ZodTypeAny, z } from 'zod';
import type { AttachmentInput } from '@helpdesk/core';
import { appError } from '../errors/app-error';

/** Multipart upload of up to 20 files, each up to 10 MB (multer enforces it while streaming). */
export const AttachmentsInterceptor = FilesInterceptor('attachments', LIMITS.attachmentsMaxCount, {
  limits: {
    fileSize: LIMITS.attachmentBytesMax,
    files: LIMITS.attachmentsMaxCount,
    fields: 20,
    fieldSize: 400_000,
    parts: 60,
  },
});

type Detail = NonNullable<ErrorResponse['error']['details']>[number];

/** Validates multipart text fields with the shared zod schema, reporting field-level errors in the shared format. */
export const parseFields = <S extends ZodTypeAny>(schema: S, fields: unknown): z.output<S> => {
  const parsed = schema.safeParse(fields);
  if (parsed.success) return parsed.data as z.output<S>;
  const details: Detail[] = parsed.error.issues.map((i) => ({
    path: i.path,
    code: i.code,
    message: i.message,
  }));
  throw appError('VALIDATION_FAILED', 'Request validation failed', details);
};

/** Files from multer -> attachment inputs; the total (not just each file) may not exceed the limit. */
export const toAttachments = (
  files: readonly Express.Multer.File[] | undefined,
  maxTotal: number,
): AttachmentInput[] => {
  const list = files ?? [];
  const total = list.reduce((n, f) => n + f.size, 0);
  if (total > maxTotal) throw appError('PAYLOAD_TOO_LARGE', 'Attachments exceed the 10 MB limit');
  return list.map((f) => ({ filename: f.originalname, contentType: f.mimetype, data: f.buffer }));
};

export const MULTIPART_BODY = {
  schema: {
    type: 'object' as const,
    properties: {
      attachments: { type: 'array' as const, items: { type: 'string' as const, format: 'binary' } },
    },
    additionalProperties: { type: 'string' as const },
  },
};
