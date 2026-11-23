import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

/** Who may call a route. Routes without the decorator are treated as admin-only (fail closed). */
export type Access = 'public' | 'staff' | 'admin' | 'customer';

export const ACCESS_KEY = 'helpdesk:access';

export const RequireAccess = (who: Access): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(ACCESS_KEY, who), ApiExtension('x-access', who));
