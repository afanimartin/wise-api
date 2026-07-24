import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { momoWebhook } from './momoWebhook.js';

describe('momoWebhook', () => {
  it('rejects invalid signatures', () => {
    process.env.WEBHOOK_SIGNATURE_SECRET = 'test-secret';
    const json = vi.fn();
    const request = {
      body: { providerReference: 'abc' },
      header: () => 'bad-signature',
    };
    const response = {
      status: vi.fn(() => ({ json })),
    };

    momoWebhook(request, response);

    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('accepts valid signatures', () => {
    process.env.WEBHOOK_SIGNATURE_SECRET = 'test-secret';
    const body = { providerReference: 'abc' };
    const signature = createHmac('sha256', 'test-secret')
      .update(JSON.stringify(body))
      .digest('hex');
    const json = vi.fn();
    const request = {
      body,
      header: () => signature,
    };
    const response = {
      status: vi.fn(() => ({ json })),
    };

    momoWebhook(request, response);

    expect(response.status).toHaveBeenCalledWith(202);
  });
});
