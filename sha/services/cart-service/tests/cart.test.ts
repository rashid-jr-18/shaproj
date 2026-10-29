/**
 * @file services/cart-service/tests/cart.test.ts
 * Cart Service & Guest-to-User Cart Merging Unit Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { InMemoryCartRepository } from '../src/repository.ts';
import { CartService } from '../src/service.ts';

describe('Cart Service & Guest Cart Merging Tests', () => {
  const repo = new InMemoryCartRepository();
  const service = new CartService(repo);

  it('should add items to cart and accurately calculate subtotal in integer paise', async () => {
    const cartId = 'guest-cart-1';
    await service.addItem(cartId, {
      product_id: 'prod-kurta-1',
      sku: 'HRA-KUR-001',
      name: 'Pure Cotton Handblock Kurta',
      price: 149900, // ₹1,499 in paise
      qty: 2,
    });

    const cart = await service.addItem(cartId, {
      product_id: 'prod-saree-1',
      sku: 'HRA-SAR-001',
      name: 'Chettinad Cotton Saree',
      price: 219900, // ₹2,199 in paise
      qty: 1,
    });

    assert.strictEqual(cart.items.length, 2);
    // Expected: (149900 * 2) + 219900 = 299800 + 219900 = 519700 (₹5,197.00)
    assert.strictEqual(cart.subtotal, 519700);
  });

  it('should update quantity and remove item when quantity is 0', async () => {
    const cartId = 'guest-cart-1';
    let cart = await service.updateItemQty(cartId, 'prod-kurta-1', 1);
    assert.strictEqual(cart.items.find((i) => i.product_id === 'prod-kurta-1')?.qty, 1);
    assert.strictEqual(cart.subtotal, 149900 + 219900); // 369800

    // Set qty to 0 -> should remove item
    cart = await service.updateItemQty(cartId, 'prod-kurta-1', 0);
    assert.strictEqual(cart.items.length, 1);
    assert.strictEqual(cart.items[0].product_id, 'prod-saree-1');
    assert.strictEqual(cart.subtotal, 219900);
  });

  it('should merge guest cart into user cart seamlessly upon login (Section 7.3)', async () => {
    const guestCartId = 'guest-session-456';
    const userCartId = 'user-cart-ravi';
    const userId = 'user-uuid-ravi';

    // Guest has: 1 Saree and 2 Chai Kulhad cups
    await service.addItem(guestCartId, {
      product_id: 'prod-saree-1',
      sku: 'HRA-SAR-001',
      name: 'Chettinad Cotton Saree',
      price: 219900,
      qty: 1,
    });
    await service.addItem(guestCartId, {
      product_id: 'prod-chai-1',
      sku: 'HRA-HOM-003',
      name: 'Chai Kulhad Set',
      price: 74900,
      qty: 2,
    });

    // Ravi already had: 1 Saree in his saved user cart
    await service.addItem(userCartId, {
      product_id: 'prod-saree-1',
      sku: 'HRA-SAR-001',
      name: 'Chettinad Cotton Saree',
      price: 219900,
      qty: 1,
    }, userId);

    // Perform merge
    const mergedCart = await service.mergeGuestCart(guestCartId, userCartId, userId);

    assert.strictEqual(mergedCart.items.length, 2);
    // Saree quantity should combine: 1 + 1 = 2
    const saree = mergedCart.items.find((i) => i.product_id === 'prod-saree-1');
    assert.strictEqual(saree?.qty, 2);

    // Chai Kulhad quantity should be 2
    const chai = mergedCart.items.find((i) => i.product_id === 'prod-chai-1');
    assert.strictEqual(chai?.qty, 2);

    // Subtotal: (219900 * 2) + (74900 * 2) = 439800 + 149800 = 589600 paise
    assert.strictEqual(mergedCart.subtotal, 589600);

    // Guest cart should be cleared from store
    const oldGuest = await repo.getCart(guestCartId);
    assert.strictEqual(oldGuest, null);
  });
});

