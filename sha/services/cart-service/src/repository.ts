/**
 * @file services/cart-service/src/repository.ts
 * Cart Repository (Redis / In-Memory Session Store with TTL)
 */

import type { Cart, CartItem } from '../../../packages/types/src/index.ts';

export interface ICartRepository {
  getCart(cartId: string): Promise<Cart | null>;
  saveCart(cart: Cart, ttlSeconds?: number): Promise<void>;
  deleteCart(cartId: string): Promise<void>;
}

export class InMemoryCartRepository implements ICartRepository {
  private store = new Map<string, { cart: Cart; expiresAt: number }>();

  async getCart(cartId: string): Promise<Cart | null> {
    const entry = this.store.get(cartId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(cartId);
      return null;
    }
    return JSON.parse(JSON.stringify(entry.cart));
  }

  async saveCart(cart: Cart, ttlSeconds: number = 7 * 24 * 3600): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(cart.id, {
      cart: JSON.parse(JSON.stringify(cart)),
      expiresAt,
    });
  }

  async deleteCart(cartId: string): Promise<void> {
    this.store.delete(cartId);
  }
}

