/**
 * @file services/notification-service/tests/notification.test.ts
 * Notification Service Event Handlers & Message Logging Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { NotificationService } from '../src/service.ts';

describe('Notification Service Tests', () => {
  const service = new NotificationService();

  it('should generate order confirmed notification and log it', async () => {
    const entry = await service.sendOrderConfirmedNotification('HRA-1234', 'customer@example.com', '₹2,998');
    assert.ok(entry.id);
    assert.strictEqual(entry.recipient, 'customer@example.com');
    assert.strictEqual(entry.status, 'SENT');
    assert.ok(entry.subject.includes('Confirmed'));
  });

  it('should generate order shipped notification with courier tracking details', async () => {
    const entry = await service.sendOrderShippedNotification(
      'HRA-1234',
      'customer@example.com',
      'BlueDart Express',
      'BD-90210'
    );
    assert.ok(entry.content.includes('BlueDart Express'));
    assert.ok(entry.content.includes('BD-90210'));
  });

  it('should generate low stock alert to store admin', async () => {
    const alert = await service.sendLowStockAlert('admin@hira.in', 'Pure Cotton Handblock Kurta', 2);
    assert.strictEqual(alert.recipient, 'admin@hira.in');
    assert.ok(alert.content.includes('only 2 left'));
  });
});

