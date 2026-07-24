import { createHmac, timingSafeEqual } from 'node:crypto';

type WebhookRequest = {
  body?: unknown;
  header: (name: string) => string | undefined;
};

type WebhookResponse = {
  status: (statusCode: number) => {
    json: (body: unknown) => void;
  };
};

export function momoWebhook(request: WebhookRequest, response: WebhookResponse): void {
  const secret = process.env.WEBHOOK_SIGNATURE_SECRET;
  if (!secret) {
    response.status(500).json({ error: 'Webhook secret is not configured' });
    return;
  }

  const signature = request.header('x-wise-signature');
  if (!signature || !verifySignature(JSON.stringify(request.body ?? {}), signature, secret)) {
    response.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  // Next step: publish verified event to Pub/Sub for ledger-safe processing.
  response.status(202).json({ status: 'accepted' });
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(signature, 'hex');

  return left.length === right.length && timingSafeEqual(left, right);
}
