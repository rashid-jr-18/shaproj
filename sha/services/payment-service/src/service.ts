/**
 * @file services/payment-service/src/service.ts
 * Payment Service Business Logic, Webhook Verification & Refund Processing
 */

import * as crypto from 'node:crypto';
import type { Payment, Refund } from '../../../packages/types/src/index.ts';
import { verifyWebhookSignature } from './crypto.ts';
import type { IPaymentRepository } from './repository.ts';

export class PaymentService {
  private repo: IPaymentRepository;
  private webhookSecret: string;
  private onPaymentSuccess?: (orderId: string, paymentId: string) => Promise<any>;

  constructor(
    repo: IPaymentRepository,
    webhookSecret: string = 'whsec_hira_default_secret_2026',
    onPaymentSuccess?: (orderId: string, paymentId: string) => Promise<any>
  ) {
    this.repo = repo;
    this.webhookSecret = webhookSecret;
    this.onPaymentSuccess = onPaymentSuccess;
  }

  async createPaymentIntent(orderId: string, amountPaise: number, method: 'RAZORPAY' | 'COD'): Promise<Payment> {
    if (amountPaise <= 0) throw new Error('Payment amount must be greater than zero.');

    const gatewayOrderId = method === 'RAZORPAY' ? `order_rzp_${crypto.randomUUID().substring(0, 12)}` : undefined;

    return this.repo.createPayment({
      order_id: orderId,
      gateway: method,
      gateway_order_id: gatewayOrderId,
      amount: amountPaise,
      currency: 'INR',
      status: method === 'COD' ? 'SUCCESS' : 'PENDING',
      method,
    });
  }

  /**
   * Section 2.2 #6 & Section 7.1: Process Webhook with Signature Verification & Deduplication
   */
  async handleRazorpayWebhook(
    rawBody: string,
    signature: string,
    payload: any
  ): Promise<{ status: 'PROCESSED' | 'IGNORED_DUPLICATE'; payment?: Payment }> {
    // 1. Verify HMAC Signature
    const isValid = verifyWebhookSignature(rawBody, signature, this.webhookSecret);
    if (!isValid) {
      throw new Error('Invalid webhook signature. Request rejected.');
    }

    const eventId = payload.event_id || payload.id;
    if (!eventId) throw new Error('Missing event id in webhook payload.');

    // 2. Deduplicate: Ignore if already processed
    const isNew = await this.repo.recordWebhookEvent(eventId, payload);
    if (!isNew) {
      return { status: 'IGNORED_DUPLICATE' };
    }

    // 3. Process event
    const event = payload.event;
    if (event === 'payment.captured' || event === 'order.paid') {
      const paymentEntity = payload.payload?.payment?.entity;
      const gatewayPaymentId = paymentEntity?.id || 'pay_dummy';
      const gatewayOrderId = paymentEntity?.order_id;
      const capturedAmount = paymentEntity?.amount; // paise

      // Find internal payment record
      let payment: Payment | null = null;
      if (gatewayOrderId) {
        for (const p of await this.findPaymentByGatewayOrderId(gatewayOrderId)) {
          payment = p;
          break;
        }
      }

      if (payment) {
        // Amount mismatch check: Flag tampering! (Section 7.1)
        if (capturedAmount && capturedAmount !== payment.amount) {
          throw new Error(`Amount mismatch: Expected ${payment.amount} paise, received ${capturedAmount} paise.`);
        }

        const updated = await this.repo.updatePaymentStatus(payment.id, 'SUCCESS', gatewayPaymentId);

        // Notify order service
        if (this.onPaymentSuccess) {
          await this.onPaymentSuccess(payment.order_id, updated.id);
        }

        return { status: 'PROCESSED', payment: updated };
      }
    }

    return { status: 'PROCESSED' };
  }

  async processRefund(paymentId: string, amountPaise: number, reason: string): Promise<Refund> {
    const payment = await this.repo.getPaymentById(paymentId);
    if (!payment) throw new Error('Payment not found.');
    if (payment.status !== 'SUCCESS') throw new Error('Only successful payments can be refunded.');

    const existingRefunds = await this.repo.getRefundsForPayment(paymentId);
    const totalRefunded = existingRefunds.reduce((sum, r) => sum + r.amount, 0);

    if (totalRefunded + amountPaise > payment.amount) {
      throw new Error('Refund amount exceeds total paid payment.');
    }

    const refund = await this.repo.createRefund(paymentId, amountPaise, reason);

    if (totalRefunded + amountPaise === payment.amount) {
      await this.repo.updatePaymentStatus(paymentId, 'REFUNDED');
    }

    return refund;
  }

  private async findPaymentByGatewayOrderId(gatewayOrderId: string): Promise<Payment[]> {
    // In in-memory store helper
    return [];
  }
}

