/**
 * @file services/inventory-service/tests/inventory.test.ts
 * Concurrency & Business Rules Unit Tests for Inventory Service
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { InMemoryInventoryRepository } from '../src/repository.ts';
import { InventoryService } from '../src/service.ts';

describe('Inventory Service & Concurrency Tests', () => {
  it('should replicate the exact Cotton Kurta stock progression from Section 3.1', async () => {
    const repo = new InMemoryInventoryRepository();
    const service = new InventoryService(repo);

    const kurtaId = 'cotton-kurta-01';

    // 1. Initial intake: Stock = 5
    await service.initializeStock(kurtaId, 5, 2);
    let state = await service.getProductInventory(kurtaId);
    assert.strictEqual(state?.on_hand, 5);
    assert.strictEqual(state?.reserved, 0);
    assert.strictEqual(state?.available, 5);

    // 2. Customer A buys 3 (Reserve -> Finalize)
    const resA = await service.reserveCart('order-A', [{ productId: kurtaId, qty: 3 }]);
    assert.strictEqual(resA.success, true);
    state = await service.getProductInventory(kurtaId);
    assert.strictEqual(state?.on_hand, 5);
    assert.strictEqual(state?.reserved, 3);
    assert.strictEqual(state?.available, 2, 'Available should be 2');

    await service.finalizeReservation('order-A');
    state = await service.getProductInventory(kurtaId);
    assert.strictEqual(state?.on_hand, 2);
    assert.strictEqual(state?.reserved, 0);
    assert.strictEqual(state?.available, 2);

    // 3. Customer B buys 2
    const resB = await service.reserveCart('order-B', [{ productId: kurtaId, qty: 2 }]);
    assert.strictEqual(resB.success, true);
    await service.finalizeReservation('order-B');
    state = await service.getProductInventory(kurtaId);
    assert.strictEqual(state?.on_hand, 0);
    assert.strictEqual(state?.available, 0, 'Available should be 0 (Out of stock)');

    // 4. Admin restocks +10
    await service.restock(kurtaId, 10, 'Fresh batch restock', 'admin-01');
    state = await service.getProductInventory(kurtaId);
    assert.strictEqual(state?.on_hand, 10);
    assert.strictEqual(state?.available, 10, 'Available should be 10 again');
  });

  it('should pass concurrency test: 50 parallel buyers for 5 pieces -> exactly 5 succeed (Section 13)', async () => {
    const repo = new InMemoryInventoryRepository();
    const service = new InventoryService(repo);

    const hotProductId = 'exclusive-silk-saree';
    const initialUnits = 5;
    await service.initializeStock(hotProductId, initialUnits, 1);

    const totalBuyers = 50;
    const buyerTasks: Promise<{ success: boolean; buyerId: number }>[] = [];

    // Launch 50 simultaneous parallel checkout reservation requests
    for (let i = 1; i <= totalBuyers; i++) {
      const orderRef = `order-concurrent-${i}`;
      buyerTasks.push(
        service.reserveCart(orderRef, [{ productId: hotProductId, qty: 1 }]).then((res) => ({
          success: res.success,
          buyerId: i,
        }))
      );
    }

    const results = await Promise.all(buyerTasks);
    const successfulBuyers = results.filter((r) => r.success);
    const failedBuyers = results.filter((r) => !r.success);

    assert.strictEqual(successfulBuyers.length, 5, 'Exactly 5 buyers must succeed');
    assert.strictEqual(failedBuyers.length, 45, 'Exactly 45 buyers must receive out-of-stock');

    const inv = await service.getProductInventory(hotProductId);
    assert.strictEqual(inv?.on_hand, 5, 'On hand is still 5 until payment finalization');
    assert.strictEqual(inv?.reserved, 5, 'Reserved must equal exactly 5');
    assert.strictEqual(inv?.available, 0, 'Available must be 0 and never negative');

    // Finalize all 5 successful buyers
    for (const buyer of successfulBuyers) {
      await service.finalizeReservation(`order-concurrent-${buyer.buyerId}`);
    }

    const finalInv = await service.getProductInventory(hotProductId);
    assert.strictEqual(finalInv?.on_hand, 0);
    assert.strictEqual(finalInv?.reserved, 0);
    assert.strictEqual(finalInv?.available, 0);
  });

  it('should enforce all-or-nothing cart reservation (atomic transaction)', async () => {
    const repo = new InMemoryInventoryRepository();
    const service = new InventoryService(repo);

    const item1 = 'prod-1';
    const item2 = 'prod-2';

    await service.initializeStock(item1, 5); // 5 in stock
    await service.initializeStock(item2, 1); // only 1 in stock

    // Cart wants 2 of item1 (valid) and 3 of item2 (insufficient)
    const cartRes = await service.reserveCart('order-cart-fail', [
      { productId: item1, qty: 2 },
      { productId: item2, qty: 3 },
    ]);

    assert.strictEqual(cartRes.success, false);
    assert.strictEqual(cartRes.failedProductId, item2);

    // item1 must NOT have any reservation held because transaction rolled back
    const inv1 = await service.getProductInventory(item1);
    assert.strictEqual(inv1?.reserved, 0, 'No units of item1 should remain reserved');
  });

  it('should release held reservation when order is cancelled or expired', async () => {
    const repo = new InMemoryInventoryRepository();
    const service = new InventoryService(repo);

    const prodId = 'prod-release-test';
    await service.initializeStock(prodId, 10);

    // Reserve 4 items
    await service.reserveCart('order-release-1', [{ productId: prodId, qty: 4 }]);
    let inv = await service.getProductInventory(prodId);
    assert.strictEqual(inv?.available, 6);

    // Checkout cancelled -> release
    await service.releaseReservation('order-release-1', 'User abandoned checkout');
    inv = await service.getProductInventory(prodId);
    assert.strictEqual(inv?.reserved, 0);
    assert.strictEqual(inv?.available, 10, 'Full stock must be restored');
  });

  it('should prevent admin from setting on_hand below currently held reservations (Section 3.5)', async () => {
    const repo = new InMemoryInventoryRepository();
    const service = new InventoryService(repo);

    const prodId = 'prod-admin-guard';
    await service.initializeStock(prodId, 10);

    // Hold 4 items in active checkouts
    await service.reserveCart('order-held-1', [{ productId: prodId, qty: 4 }]);

    // Admin tries to adjust on_hand down to 2 while 4 are held -> should throw
    await assert.rejects(
      () => service.adjustStock(prodId, 2, 'Miscount correction', 'admin-1'),
      /cannot be set below active reservations/i
    );

    // Adjusting to 6 (>= 4) is permitted
    const adjusted = await service.adjustStock(prodId, 6, 'Valid correction', 'admin-1');
    assert.strictEqual(adjusted.on_hand, 6);
    assert.strictEqual(adjusted.reserved, 4);
  });
});

