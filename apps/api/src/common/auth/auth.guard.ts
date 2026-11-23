import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Db } from '@helpdesk/core';
import type { Clock, Principal } from '@helpdesk/shared';
import { resolveTicketLink } from '../../modules/auth/link-tokens';
import { verifyAccessToken } from '../../modules/auth/domain/jwt';
import { findUserById, loadMemberships, sessionActive } from '../../modules/auth/repo/auth-repo';
import { CLOCK, DB, ENV } from '../../infra/tokens';
import { appError } from '../errors/app-error';
import { ACCESS_KEY, type Access } from './access';
import type { AuthedRequest } from './request-auth';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/** Global guard: every route is checked here, on the server, before any handler runs. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: { readonly JWT_ACCESS_SECRET: string },
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access =
      this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? 'admin';
    if (access === 'public') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (access === 'customer') {
      const raw = req.headers['x-ticket-token'];
      const token = typeof raw === 'string' ? raw : '';
      const link = await resolveTicketLink(this.db, token, this.clock.now());
      if (!link.ok) throw appError(link.error, linkMessage(link.error));
      req.auth = {
        kind: 'customer',
        linkId: link.value.linkId,
        principal: {
          kind: 'customer',
          customerId: link.value.customerId,
          ticketId: link.value.ticketId,
        },
      };
      return true;
    }

    const header = req.headers.authorization;
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    if (match?.[1] === undefined) throw appError('UNAUTHORIZED', 'Authentication required');
    const verified = await verifyAccessToken(
      this.env.JWT_ACCESS_SECRET,
      match[1],
      this.clock.now(),
    );
    if (!verified.ok) {
      throw appError(
        verified.error === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED',
        'Authentication required',
      );
    }
    const user = await findUserById(this.db, verified.value.userId);
    if (
      user === null ||
      !user.isActive ||
      user.tokenVersion !== verified.value.version ||
      !(await sessionActive(this.db, verified.value.sessionId))
    ) {
      throw appError('UNAUTHORIZED', 'Authentication required');
    }
    const principal: Principal =
      user.role === 'admin'
        ? { kind: 'admin', userId: user.id }
        : {
            kind: 'staff',
            userId: user.id,
            memberships: (await loadMemberships(this.db, user.id)) as never,
          };
    if (access === 'admin' && principal.kind !== 'admin')
      throw appError('FORBIDDEN', 'Administrator access required');
    req.auth = {
      kind: 'staff',
      principal,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
    return true;
  }
}

const linkMessage = (code: 'LINK_INVALID' | 'LINK_EXPIRED' | 'LINK_REVOKED'): string =>
  code === 'LINK_EXPIRED'
    ? 'This link has expired'
    : code === 'LINK_REVOKED'
      ? 'This link is no longer valid'
      : 'Invalid link';
