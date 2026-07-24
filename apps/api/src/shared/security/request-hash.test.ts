import { describe, expect, it } from 'vitest';
import { hashRequestBody } from './request-hash.js';

describe('hashRequestBody', () => {
  it('creates the same hash for objects with different key order', () => {
    const left = hashRequestBody({ amountMinor: 1000, currency: 'SSP' });
    const right = hashRequestBody({ currency: 'SSP', amountMinor: 1000 });

    expect(left).toBe(right);
  });
});
