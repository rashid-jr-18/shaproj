/**
 * @file services/payment-service/src/repository.ts
 * Payment Repository with Webhook Deduplication & Refund Ledger
 */

import * as crypto from 'node:crypto';
import type { Payment, Refund, WebhookEvent } from '../../../packages/types/src/index.ts';

export interface IPaymentRepository {
  createPayment(data: Omit<Payment, 'id' | 'created_at'>): Promise<Payment>;
  getPaymentById(id: string): Promise<Payment | null>;
  getPaymentByOrderId(orderId: string): Promise<Payment | null>;
  updatePaymentStatus(id: string, status: Payment['status'], gatewayPaymentId?: string): Promise<Payment>;

  recordWebhookEvent(eventId: string, payload: any): Promise<boolean>; // Returns false if already processed
  hasProcessedWebhook(eventId: string): Promise<boolean>;

  createRefund(paymentId: string, amount: number, reason: string): Promise<Refund>;
  getRefundsForPayment(paymentId: string): Promise<Refund[]>;
}

export class InMemoryPaymentRepository implements IPaymentRepository {
  private payments = new Map<string, Payment>();
  private refunds: Refund[] = [];
  private processedWebhooks = new Set<string>();

  async createPayment(data: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
    const id = crypto.randomUUID();
    const payment: Payment = {
      ...data,
      id,
      created_at: new Date().toISOString(),
    };
    this.payments.set(id, payment);
    return payment;
  }

  async getPaymentById(id: string): Promise<Payment | null> {
    return this.payments.get(id) || null;
  }

  async getPaymentByOrderId(orderId: string): Promise<Payment | null> {
    for (const p of this.payments.values()) {
      if (p.order_id === orderId) return { ...p };
    }
    return null;
  }

  async updatePaymentStatus(id: string, status: Payment['status'], gatewayPaymentId?: string): Promise<Payment> {
    const p = this.payments.get(id);
    if (!p) throw new Error('Payment not found.');
    p.status = status;
    if (gatewayPaymentId) p.gateway_payment_id = gatewayPaymentId;
    this.payments.set(id, p);
    return { ...p };
  }

  async recordWebhookEvent(eventId: string, payload: any): Promise<boolean> {
    if (this.processedWebhooks.has(eventId)) {
      return false; // Already processed
    }
    this.processedWebhooks.add(eventId);
    return true;
  }

  async hasProcessedWebhook(eventId: string): Promise<boolean> {
    return this.processedWebhooks.has(eventId);
  }

  async createRefund(paymentId: string, amount: number, reason: string): Promise<Refund> {
    const refund: Refund = {
      id: crypto.randomUUID(),
      payment_id: paymentId,
      amount,
      status: 'PROCESSED',
      reason,
      created_at: new Date().toISOString(),
    };
    this.refunds.push(refund);
    return refund;
  }

  async getRefundsForPayment(paymentId: string): Promise<Refund[]> {
    return this.refunds.filter((r) => r.payment_id === paymentId);
  }
}

