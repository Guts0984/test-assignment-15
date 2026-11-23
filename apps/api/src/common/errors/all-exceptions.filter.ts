import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  type ErrorCode,
  type ErrorResponse,
} from '@helpdesk/shared';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';
import { isAppErrorBody } from './app-error';

type Details = NonNullable<ErrorResponse['error']['details']>;

const zodDetails = (e: ZodError): Details =>
  e.issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));

const body = (
  code: ErrorCode,
  message: string,
  requestId: string | undefined,
  details?: Details,
): ErrorResponse => ({
  error: {
    code,
    message,
    ...(details === undefined ? {} : { details }),
    ...(requestId === undefined ? {} : { requestId }),
  },
});

const statusToCode = (status: number): ErrorCode => {
  if (status === 404) return 'NOT_FOUND';
  if (status === 405) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 409) return 'CONFLICT';
  return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
};

/** Every failure leaves the API in the same shape; nothing internal (stack, SQL, paths) is ever echoed. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId =
      typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;
    const send = (status: number, payload: ErrorResponse): void => {
      if (!res.headersSent) res.status(status).json(payload);
    };

    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as ZodError;
      send(
        400,
        body('VALIDATION_FAILED', 'Request validation failed', requestId, zodDetails(zodError)),
      );
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      if (isAppErrorBody(raw) && ERROR_CODES.includes(raw.code)) {
        send(ERROR_HTTP_STATUS[raw.code], body(raw.code, raw.message, requestId, raw.details));
        return;
      }
      if (status === 400 && /JSON|Unexpected (token|end)/i.test(exception.message)) {
        send(400, body('MALFORMED_JSON', 'Request body is not valid JSON', requestId));
        return;
      }
      send(
        status,
        body(
          statusToCode(status),
          status === 404 ? 'Resource not found' : exception.message,
          requestId,
        ),
      );
      return;
    }
    // body-parser / express errors carry a status and a type
    const err = exception as { status?: number; statusCode?: number; type?: string };
    const status = err.status ?? err.statusCode;
    if (err.type === 'entity.too.large') {
      send(413, body('PAYLOAD_TOO_LARGE', 'Request body is too large', requestId));
      return;
    }
    const message = exception instanceof Error ? exception.message : '';
    if (
      err.type === 'entity.parse.failed' ||
      err.type === 'encoding.unsupported' ||
      err.type === 'charset.unsupported' ||
      (status === 400 &&
        (exception instanceof SyntaxError || /JSON|Unexpected (token|end)/i.test(message)))
    ) {
      send(400, body('MALFORMED_JSON', 'Request body is not valid JSON', requestId));
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      send(status, body(statusToCode(status), 'Request could not be processed', requestId));
      return;
    }
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    send(500, body('INTERNAL_ERROR', 'Internal server error', requestId));
  }
}
