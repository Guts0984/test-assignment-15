import { type Result } from '@helpdesk/shared';
import { appError } from '../../common/errors/app-error';

/** Turns an expected failure value into the HTTP error the client sees. */
export const unwrap = <T>(r: Result<T, 'NOT_FOUND' | 'CONFLICT'>): T => {
  if (r.ok) return r.value;
  throw r.error === 'NOT_FOUND'
    ? appError('NOT_FOUND', 'Resource not found')
    : appError('CONFLICT', 'Resource already exists or conflicts with existing data');
};
