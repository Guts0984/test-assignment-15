import { describe, expect, it } from 'vitest';
import { isApiError, messageForCode, toFieldErrors } from './api-errors';

const body = (details: { path: (string | number)[]; message: string }[]) => ({
  error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', details },
});

describe('api error mapping', () => {
  it('maps server validation details onto the matching form fields', () => {
    const r = toFieldErrors(
      body([
        { path: ['email'], message: 'Invalid email' },
        { path: ['subject'], message: 'Required' },
      ]),
      ['email', 'subject', 'body'],
    );
    expect(r.fields).toEqual([
      { field: 'email', message: 'Invalid email' },
      { field: 'subject', message: 'Required' },
    ]);
    expect(r.form).toBeNull();
  });

  it('turns details for unknown fields into a form-level message instead of dropping them', () => {
    const r = toFieldErrors(body([{ path: ['mystery'], message: 'Bad' }]), ['email']);
    expect(r.fields).toHaveLength(0);
    expect(r.form).toBe('Bad');
  });

  it('handles non-validation errors and unknown payloads', () => {
    expect(toFieldErrors({ error: { code: 'CONFLICT', message: 'Exists' } }, ['x']).form).toBe(
      'Exists',
    );
    expect(toFieldErrors(undefined, ['x']).form).toContain('Something went wrong');
    expect(isApiError({ error: { code: 'X', message: 'm' } })).toBe(true);
    expect(isApiError({ error: 5 })).toBe(false);
  });

  it('has friendly texts for the important codes', () => {
    expect(messageForCode('TICKET_HAS_NEW_MESSAGES', 'x')).toContain('new messages');
    expect(messageForCode('UNKNOWN', 'fallback')).toBe('fallback');
  });
});
