/**
 * @file services/payment-service/src/crypto.ts
 * Webhook HMAC Signature Verification (Razorpay compliant)
 */

import * as crypto from 'node:crypto';

export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

export function computeWebhookSignature(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

