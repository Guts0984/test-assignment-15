import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorResponse } from '@helpdesk/shared';

type Detail = NonNullable<ErrorResponse['error']['details']>[number];

/** Builds the one HTTP error type the API throws; the exception filter renders it in the shared format. */
export const appError = (
  code: ErrorCode,
  message: string,
  details?: readonly Detail[],
): HttpException => new HttpException({ code, message, details }, ERROR_HTTP_STATUS[code]);

export const isAppErrorBody = (
  v: unknown,
): v is { code: ErrorCode; message: string; details?: Detail[] } =>
  typeof v === 'object' && v !== null && 'code' in v && 'message' in v;
