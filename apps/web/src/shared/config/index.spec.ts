import { describe, expect, it } from 'vitest';
import { productName } from './index';

describe('shared/config', () => {
  it('exposes the product name', () => {
    expect(productName).toBe('Helpdesk');
  });
});
