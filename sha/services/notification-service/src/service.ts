/**
 * @file services/notification-service/src/service.ts
 * Notification Service Event Handlers & Message Logging
 */

import * as crypto from 'node:crypto';

export interface NotificationLogEntry {
  id: string;
  recipient: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP';
  subject: string;
  content: string;
  status: 'SENT' | 'FAILED';
  created_at: string;
}

export class NotificationService {
  private log: NotificationLogEntry[] = [];

  async sendOrderConfirmedNotification(orderNo: string, email: string, amountFormatted: string) {
    const entry: NotificationLogEntry = {
      id: crypto.randomUUID(),
      recipient: email,
      channel: 'EMAIL',
      subject: `Your Hira Order ${orderNo} is Confirmed!`,
      content: `Thank you for shopping at Hira. Your order ${orderNo} of ${amountFormatted} has been confirmed and is being packed.`,
      status: 'SENT',
      created_at: new Date().toISOString(),
    };
    this.log.unshift(entry);
    return entry;
  }

  async sendOrderShippedNotification(orderNo: string, email: string, courierName: string, trackingNo: string) {
    const entry: NotificationLogEntry = {
      id: crypto.randomUUID(),
      recipient: email,
      channel: 'EMAIL',
      subject: `Your Hira Order ${orderNo} has Shipped!`,
      content: `Your package has been dispatched via ${courierName} with tracking number ${trackingNo}.`,
      status: 'SENT',
      created_at: new Date().toISOString(),
    };
    this.log.unshift(entry);
    return entry;
  }

  async sendLowStockAlert(adminEmail: string, productName: string, available: number) {
    const entry: NotificationLogEntry = {
      id: crypto.randomUUID(),
      recipient: adminEmail,
      channel: 'EMAIL',
      subject: `Low Stock Alert: ${productName}`,
      content: `Product "${productName}" is running low on stock (only ${available} left). Restock recommended.`,
      status: 'SENT',
      created_at: new Date().toISOString(),
    };
    this.log.unshift(entry);
    return entry;
  }

  getLogs(recipient?: string): NotificationLogEntry[] {
    if (!recipient) return [...this.log];
    return this.log.filter((l) => l.recipient === recipient);
  }
}

