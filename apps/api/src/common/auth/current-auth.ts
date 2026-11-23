import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { appError } from '../errors/app-error';
import type { AuthedRequest, RequestAuth } from './request-auth';

/** Injects the authenticated caller; routes using it are always behind the auth guard. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAuth => {
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (auth === undefined) throw appError('UNAUTHORIZED', 'Authentication required');
    return auth;
  },
);
