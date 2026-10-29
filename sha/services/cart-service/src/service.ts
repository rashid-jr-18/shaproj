/**
 * @file services/cart-service/src/service.ts
 * Cart Service Business Logic & Guest Cart Merging
 */

import type { Cart, CartItem } from '../../../packages/types/src/index.ts';
import type { ICartRepository } from './repository.ts';

export class CartService {
  private repo: ICartRepository;

  constructor(repo: ICartRepository) {
    this.repo = repo;
  }

  async getOrCreateCart(cartId: string, userId?: string): Promise<Cart> {
    let cart = await this.repo.getCart(cartId);
    if (!cart) {
      cart = {
        id: cartId,
        user_id: userId || null,
        items: [],
        subtotal: 0,
        updated_at: new Date().toISOString(),
      };
      await this.repo.saveCart(cart);
    }
    return cart;
  }

  async addItem(cartId: string, item: CartItem, userId?: string): Promise<Cart> {
    if (item.qty <= 0) throw new Error('Quantity must be greater than zero.');
    if (item.price < 0) throw new Error('Price cannot be negative.');

    const cart = await this.getOrCreateCart(cartId, userId);
    const existingIndex = cart.items.findIndex((i) => i.product_id === item.product_id);

    if (existingIndex >= 0) {
      cart.items[existingIndex].qty += item.qty;
    } else {
      cart.items.push({ ...item });
    }

    this.recalculateCart(cart);
    await this.repo.saveCart(cart);
    return cart;
  }

  async updateItemQty(cartId: string, productId: string, newQty: number): Promise<Cart> {
    const cart = await this.repo.getCart(cartId);
    if (!cart) throw new Error('Cart not found.');

    if (newQty <= 0) {
      cart.items = cart.items.filter((i) => i.product_id !== productId);
    } else {
      const existing = cart.items.find((i) => i.product_id === productId);
      if (existing) {
        existing.qty = Math.round(newQty);
      }
    }

    this.recalculateCart(cart);
    await this.repo.saveCart(cart);
    return cart;
  }

  async removeItem(cartId: string, productId: string): Promise<Cart> {
    return this.updateItemQty(cartId, productId, 0);
  }

  async clearCart(cartId: string): Promise<void> {
    await this.repo.deleteCart(cartId);
  }

  /**
   * Section 7.3: Merge guest cart into user cart at login
   */
  async mergeGuestCart(guestCartId: string, userCartId: string, userId: string): Promise<Cart> {
    const guestCart = await this.repo.getCart(guestCartId);
    const userCart = await this.getOrCreateCart(userCartId, userId);

    if (!guestCart || guestCart.items.length === 0) {
      return userCart;
    }

    for (const gItem of guestCart.items) {
      const existing = userCart.items.find((i) => i.product_id === gItem.product_id);
      if (existing) {
        existing.qty += gItem.qty;
      } else {
        userCart.items.push({ ...gItem });
      }
    }

    this.recalculateCart(userCart);
    await this.repo.saveCart(userCart);
    await this.repo.deleteCart(guestCartId); // Clean up guest cart

    return userCart;
  }

  private recalculateCart(cart: Cart) {
    let subtotal = 0;
    for (const item of cart.items) {
      subtotal += item.price * item.qty;
    }
    cart.subtotal = subtotal;
    cart.updated_at = new Date().toISOString();
  }
}

