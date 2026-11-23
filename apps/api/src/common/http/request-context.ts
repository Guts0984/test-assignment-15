import { randomUUID } from 'node:crypto';
import type { Clock } from '@helpdesk/shared';
import type { NextFunction, Request, Response } from 'express';
import { appError } from '../errors/app-error';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Request id, server clock and instance headers on every response; the web client derives its SLA countdown skew from X-Server-Time. */
export const requestContext =
  (clock: Clock, instanceId: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    res.setHeader('x-api-instance', instanceId);
    res.setHeader('x-server-time', clock.now().toISOString());
    res.setHeader('cache-control', 'no-store');
    next();
  };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Rejects non-JSON bodies with 415 instead of letting them reach validation as an empty object.
 * Multipart (uploads) and raw mail are allowed on the routes that declare them.
 */
export const requireJsonBodies =
  (allowedPrefixes: readonly string[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!BODY_METHODS.has(req.method)) return next();
    const length = Number(req.headers['content-length'] ?? 0);
    const chunked = req.headers['transfer-encoding'] !== undefined;
    if (length === 0 && !chunked) return next();
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (type.startsWith('application/json') || type.startsWith('application/problem+json'))
      return next();
    if (allowedPrefixes.some((p) => req.path.startsWith(p))) return next();
    next(appError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
  };
