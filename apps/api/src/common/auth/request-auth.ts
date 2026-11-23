import type { Principal } from '@helpdesk/shared';
import type { Request } from 'express';

export type AuthedStaff = {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'admin' | 'staff';
};

export type RequestAuth =
  | { readonly kind: 'staff'; readonly principal: Principal; readonly user: AuthedStaff }
  | {
      readonly kind: 'customer';
      readonly principal: Principal & { kind: 'customer' };
      readonly linkId: string;
    };

export type AuthedRequest = Request & { auth?: RequestAuth };

export const AUTH_REQUEST_KEY = 'auth' as const;
