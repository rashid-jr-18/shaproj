/**
 * @file services/payment-service/tests/payment.test.ts
 * Payment Service, Signed Webhook & Deduplication Unit Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { InMemoryPaymentRepository } from '../src/repository.ts';
import { PaymentService } from '../src/service.ts';
import { computeWebhookSignature } from '../src/crypto.ts';

describe('Payment Service & Webhook Security Tests', () => {
  const repo = new InMemoryPaymentRepository();
  const secret = 'test_webhook_secret_key_123';
  const service = new PaymentService(repo, secret);

  it('should create payment intent in integer paise', async () => {
    const payment = await service.createPaymentIntent('order-123', 299800, 'RAZORPAY');
    assert.ok(payment.id);
    assert.strictEqual(payment.amount, 299800);
    assert.strictEqual(payment.status, 'PENDING');
    assert.ok(payment.gateway_order_id?.startsWith('order_rzp_'));
  });

  it('should verify valid webhook signature and process event (OWASP A08)', async () => {
    const payload = {
      event_id: 'evt_001',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_rzp_999',
            amount: 299800,
          },
        },
      },
    };

    const rawBody = JSON.stringify(payload);
    const validSignature = computeWebhookSignature(rawBody, secret);

    const result = await service.handleRazorpayWebhook(rawBody, validSignature, payload);
    assert.strictEqual(result.status, 'PROCESSED');
  });

  it('should reject webhook with invalid or forged signature (Section 7.1 & 8.2)', async () => {
    const payload = { event_id: 'evt_forged', event: 'payment.captured' };
    const rawBody = JSON.stringify(payload);
    const forgedSignature = 'invalid_tampered_signature_hex';

    await assert.rejects(
      () => service.handleRazorpayWebhook(rawBody, forgedSignature, payload),
      /Invalid webhook signature/i
    );
  });

  it('should deduplicate replayed webhook events (Section 7.1)', async () => {
    const payload = {
      event_id: 'evt_duplicate_check',
      event: 'payment.captured',
    };
    const rawBody = JSON.stringify(payload);
    const signature = computeWebhookSignature(rawBody, secret);

    // First arrival
    const firstCall = await service.handleRazorpayWebhook(rawBody, signature, payload);
    assert.strictEqual(firstCall.status, 'PROCESSED');

    // Duplicate replay
    const secondCall = await service.handleRazorpayWebhook(rawBody, signature, payload);
    assert.strictEqual(secondCall.status, 'IGNORED_DUPLICATE', 'Replayed webhook event must be ignored');
  });

  it('should process full and partial refunds up to paid amount', async () => {
    const payment = await repo.createPayment({
      order_id: 'order-refund-test',
      gateway: 'RAZORPAY',
      amount: 100000, // ₹1,000
      currency: 'INR',
      status: 'SUCCESS',
    });

    // Partial refund of ₹400
    const partial = await service.processRefund(payment.id, 40000, 'Customer returned 1 item');
    assert.strictEqual(partial.amount, 40000);
    assert.strictEqual(partial.status, 'PROCESSED');

    // Excess refund attempt while partially refunded (trying to refund ₹700 when only ₹600 remaining)
    await assert.rejects(
      () => service.processRefund(payment.id, 70000, 'Excess refund'),
      /exceeds total paid payment/i
    );

    // Remaining valid refund of ₹600
    const remaining = await service.processRefund(payment.id, 60000, 'Customer returned remaining items');
    assert.strictEqual(remaining.amount, 60000);

    const updatedPayment = await repo.getPaymentById(payment.id);
    assert.strictEqual(updatedPayment?.status, 'REFUNDED');
  });

  it('should reject refund on non-successful payments (OWASP ASVS Level 2)', async () => {
    const pendingPayment = await repo.createPayment({
      order_id: 'order-pending-test',
      gateway: 'RAZORPAY',
      amount: 50000,
      currency: 'INR',
      status: 'PENDING',
    });

    await assert.rejects(
      () => service.processRefund(pendingPayment.id, 50000, 'Premature refund attempt'),
      /Only successful payments can be refunded/i
    );
  });
});
