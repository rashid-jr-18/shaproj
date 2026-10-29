/**
 * @file services/order-service/tests/order.test.ts
 * Order Service, Checkout Saga & State Machine Unit Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { InMemoryOrderRepository } from '../src/repository.ts';
import { OrderService } from '../src/service.ts';

describe('Order Service & State Machine Lifecycle Tests', () => {
  const repo = new InMemoryOrderRepository();
  const reservedOrders = new Set<string>();
  const finalizedOrders = new Set<string>();

  const service = new OrderService(repo, {
    catalogLookup: async (productId) => {
      if (productId === 'prod-kurta') {
        return {
          id: 'prod-kurta',
          sku: 'HRA-KUR-001',
          name: 'Pure Cotton Handblock Kurta',
          price: 149900, // ₹1,499
          tax_rate: 5,
          status: 'ACTIVE',
        };
      }
      if (productId === 'prod-saree') {
        return {
          id: 'prod-saree',
          sku: 'HRA-SAR-001',
          name: 'Chettinad Cotton Saree',
          price: 219900, // ₹2,199
          tax_rate: 5,
          status: 'ACTIVE',
        };
      }
      return null;
    },
    inventoryReserve: async (orderRef, items) => {
      reservedOrders.add(orderRef);
      return { success: true };
    },
    inventoryFinalize: async (orderRef) => {
      finalizedOrders.add(orderRef);
      return true;
    },
    inventoryRelease: async (orderRef) => {
      reservedOrders.delete(orderRef);
      return true;
    },
  });

  const sampleAddress = {
    name: 'Priya Sundaram',
    phone: '+919876501234',
    line1: '45 Anna Nagar West',
    city: 'Chennai',
    state: 'Tamil Nadu',
    pincode: '600040',
  };

  it('should successfully place an order through the checkout saga with server price verification', async () => {
    const order = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-kurta', qty: 2 }],
      address: sampleAddress,
      paymentMethod: 'RAZORPAY',
      idempotencyKey: 'idem-key-101',
    });

    assert.ok(order.id);
    assert.strictEqual(order.status, 'PENDING_PAYMENT');
    // Subtotal: 149900 * 2 = 299800
    // Tax (5%): 14990
    // Shipping: subtotal > 99900 so 0
    assert.strictEqual(order.subtotal, 299800);
    assert.strictEqual(order.tax, 14990);
    assert.strictEqual(order.shipping_fee, 0);
    assert.strictEqual(order.total, 299800 + 14990);
    assert.strictEqual(order.items?.length, 1);
    assert.ok(reservedOrders.has(order.order_no), 'Inventory should be reserved');
  });

  it('should return identical order when same Idempotency-Key is replayed (Section 7.1)', async () => {
    const replayOrder = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-kurta', qty: 2 }],
      address: sampleAddress,
      paymentMethod: 'RAZORPAY',
      idempotencyKey: 'idem-key-101', // Replayed key
    });

    assert.ok(replayOrder.id);
    assert.strictEqual(replayOrder.idempotency_key, 'idem-key-101');
  });

  it('should move order through full delivery lifecycle: CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED', async () => {
    const order = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-saree', qty: 1 }],
      address: sampleAddress,
      paymentMethod: 'RAZORPAY',
      idempotencyKey: 'idem-key-lifecycle',
    });

    // 1. Payment confirmed via webhook
    const confirmed = await service.confirmPayment(order.id);
    assert.strictEqual(confirmed.status, 'CONFIRMED');
    assert.ok(finalizedOrders.has(order.order_no), 'Inventory finalize should be triggered on payment');

    // 2. Admin starts processing
    const processing = await service.startProcessing(order.id, 'admin-01');
    assert.strictEqual(processing.status, 'PROCESSING');

    // 3. Admin ships order
    const shipped = await service.markAsShipped(order.id, 'BlueDart Express', 'BLUEDART-9921', 'admin-01');
    assert.strictEqual(shipped.status, 'SHIPPED');

    // 4. Mark delivered
    const delivered = await service.markAsDelivered(order.id, 'courier-webhook');
    assert.strictEqual(delivered.status, 'DELIVERED');

    // Verify audit trail
    const history = await service.getStatusHistory(order.id);
    assert.ok(history.length >= 5);
  });

  it('should reject illegal state machine transitions (Section 2.2 #4)', async () => {
    const order = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-kurta', qty: 1 }],
      address: sampleAddress,
      paymentMethod: 'RAZORPAY',
      idempotencyKey: 'idem-key-illegal',
    });

    // Cannot jump from PENDING_PAYMENT directly to DELIVERED
    await assert.rejects(
      () => service.markAsDelivered(order.id),
      /Illegal order state transition/i
    );
  });

  it('should block customer cancellation after order is SHIPPED (Section 6.1)', async () => {
    const order = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-kurta', qty: 1 }],
      address: sampleAddress,
      paymentMethod: 'RAZORPAY',
      idempotencyKey: 'idem-key-cancel-guard',
    });

    await service.confirmPayment(order.id);
    await service.startProcessing(order.id, 'admin-1');
    await service.markAsShipped(order.id, 'Delhivery', 'DLH-1234', 'admin-1');

    // Cancellation must be blocked
    await assert.rejects(
      () => service.cancelOrder(order.id, 'Changed mind', 'user-priya'),
      /cannot be cancelled in state SHIPPED/i
    );
  });

  it('should handle Cash on Delivery: skips PENDING_PAYMENT to CONFIRMED and enforces ₹5,000 threshold', async () => {
    // Valid COD under ₹5,000
    const codOrder = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-kurta', qty: 1 }],
      address: sampleAddress,
      paymentMethod: 'COD',
      idempotencyKey: 'idem-cod-valid',
    });

    assert.strictEqual(codOrder.status, 'CONFIRMED', 'COD orders must go directly to CONFIRMED');

    // Exceeding ₹5,000 on COD should be rejected
    await assert.rejects(
      () =>
        service.placeOrder({
          userId: 'user-priya',
          items: [
            { productId: 'prod-kurta', qty: 2 }, // ~3,000
            { productId: 'prod-saree', qty: 2 }, // ~4,400 -> total > ₹5,000
          ],
          address: sampleAddress,
          paymentMethod: 'COD',
          idempotencyKey: 'idem-cod-too-large',
        }),
      /limited to orders up to ₹5,000/i
    );
  });

  it('should enforce return request eligibility: DELIVERED only, with user ownership check', async () => {
    // 1. Order in PENDING_PAYMENT -> return request should be rejected
    const newOrder = await service.placeOrder({
      userId: 'user-priya',
      items: [{ productId: 'prod-kurta', qty: 1 }],
      address: sampleAddress,
      paymentMethod: 'RAZORPAY',
      idempotencyKey: 'idem-return-test-01',
    });

    await assert.rejects(
      () => service.requestReturn(newOrder.id, 'Wrong size', 'user-priya'),
      /Only delivered orders can be returned/i
    );

    // 2. Deliver the order
    await service.confirmPayment(newOrder.id);
    await service.startProcessing(newOrder.id, 'admin-1');
    await service.markAsShipped(newOrder.id, 'Delhivery', 'DLH-RETURN', 'admin-1');
    await service.markAsDelivered(newOrder.id, 'admin-1');

    // 3. Unauthorized user cannot request return
    await assert.rejects(
      () => service.requestReturn(newOrder.id, 'Wrong size', 'other-intruder'),
      /unauthorized/i
    );

    // 4. Legitimate customer requests return -> success
    const ret = await service.requestReturn(newOrder.id, 'Size too large', 'user-priya');
    assert.ok(ret.id);
    assert.strictEqual(ret.status, 'REQUESTED');
    assert.strictEqual(ret.refund_amount, newOrder.total);

    const updated = await service.getOrder(newOrder.id);
    assert.strictEqual(updated?.status, 'RETURN_REQUESTED');
  });
});

