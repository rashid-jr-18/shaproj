/**
 * @file services/inventory-service/src/repository.ts
 * Inventory Service Repository with Atomic Stock Reservations & Movement Ledger
 */

import * as crypto from 'node:crypto';
import type {
  Inventory,
  Reservation,
  StockMovement,
  ReservationStatus,
  StockMovementType,
} from '../../../packages/types/src/index.ts';

export interface ReserveItemRequest {
  productId: string;
  qty: number;
}

export interface IInventoryRepository {
  getInventory(productId: string): Promise<Inventory | null>;
  getAllInventory(): Promise<Map<string, Inventory>>;
  initProductInventory(productId: string, initialOnHand: number, threshold?: number): Promise<Inventory>;
  
  // Atomic multi-item cart reservation (All-or-nothing transaction)
  reserveCart(orderRef: string, items: ReserveItemRequest[], expiryMinutes?: number): Promise<{ success: boolean; failedProductId?: string }>;
  
  // Finalize reservation upon successful payment (reserved -> deduction from on_hand)
  finalizeReservation(orderRef: string): Promise<boolean>;
  
  // Release reservation upon failure or cancellation
  releaseReservation(orderRef: string, reason?: string): Promise<boolean>;
  
  // Admin Restock (+qty)
  restock(productId: string, qty: number, note: string, actorId?: string): Promise<Inventory>;
  
  // Admin Stock Adjustment
  adjustStock(productId: string, newOnHand: number, reason: string, actorId?: string): Promise<Inventory>;

  // Stock movements query
  getMovements(productId?: string): Promise<StockMovement[]>;
}

export class InMemoryInventoryRepository implements IInventoryRepository {
  private inventory = new Map<string, Inventory>();
  private reservations = new Map<string, Reservation[]>(); // orderRef -> list of reservations
  private movements: StockMovement[] = [];

  // Lock queue simulation to ensure atomic operations without race conditions
  private mutex = Promise.resolve();

  private runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.mutex.then(fn);
    this.mutex = next.catch(() => {}) as Promise<void>;
    return next;
  }

  async getInventory(productId: string): Promise<Inventory | null> {
    const item = this.inventory.get(productId);
    return item ? { ...item } : null;
  }

  async getAllInventory(): Promise<Map<string, Inventory>> {
    const map = new Map<string, Inventory>();
    for (const [k, v] of this.inventory.entries()) {
      map.set(k, { ...v });
    }
    return map;
  }

  async initProductInventory(productId: string, initialOnHand: number, threshold: number = 3): Promise<Inventory> {
    return this.runExclusive(() => {
      const existing = this.inventory.get(productId);
      if (existing) return { ...existing };

      const item: Inventory = {
        product_id: productId,
        on_hand: initialOnHand,
        reserved: 0,
        low_stock_threshold: threshold,
        updated_at: new Date().toISOString(),
      };
      this.inventory.set(productId, item);

      this.logMovement({
        product_id: productId,
        type: 'INITIAL',
        qty_change: initialOnHand,
        reason: 'Initial stock intake',
      });

      return { ...item };
    });
  }

  /**
   * Section 3.4 Atomic Cart Reservation
   * "Run the whole cart reservation inside one transaction so a 3-item cart either reserves everything or nothing."
   */
  async reserveCart(
    orderRef: string,
    items: ReserveItemRequest[],
    expiryMinutes: number = 15
  ): Promise<{ success: boolean; failedProductId?: string }> {
    return this.runExclusive(() => {
      // Step 1: Pre-check all items atomically
      for (const item of items) {
        const inv = this.inventory.get(item.productId);
        if (!inv) {
          return { success: false, failedProductId: item.productId };
        }
        const available = inv.on_hand - inv.reserved;
        if (available < item.qty) {
          return { success: false, failedProductId: item.productId };
        }
      }

      // Step 2: Apply reservation to all items
      const now = new Date();
      const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000).toISOString();
      const createdReservations: Reservation[] = [];

      for (const item of items) {
        const inv = this.inventory.get(item.productId)!;
        inv.reserved += item.qty;
        inv.updated_at = now.toISOString();
        this.inventory.set(item.productId, inv);

        const resId = crypto.randomUUID();
        const reservation: Reservation = {
          id: resId,
          order_ref: orderRef,
          product_id: item.productId,
          qty: item.qty,
          status: 'HELD',
          expires_at: expiresAt,
          created_at: now.toISOString(),
        };
        createdReservations.push(reservation);

        this.logMovement({
          product_id: item.productId,
          type: 'RESERVATION_HOLD',
          qty_change: -item.qty,
          reason: `Reserved for checkout order ${orderRef}`,
          order_ref: orderRef,
        });
      }

      this.reservations.set(orderRef, createdReservations);
      return { success: true };
    });
  }

  /**
   * Section 3.2 Finalize Reservation upon payment success:
   * reserved converts into a real deduction from on_hand.
   */
  async finalizeReservation(orderRef: string): Promise<boolean> {
    return this.runExclusive(() => {
      const resList = this.reservations.get(orderRef);
      if (!resList || resList.length === 0) return false;

      const now = new Date().toISOString();
      for (const res of resList) {
        if (res.status !== 'HELD') continue;

        const inv = this.inventory.get(res.product_id);
        if (inv) {
          // Deduct from on_hand and release reserved
          inv.on_hand -= res.qty;
          inv.reserved -= res.qty;
          inv.updated_at = now;
          this.inventory.set(res.product_id, inv);

          res.status = 'CONFIRMED';

          this.logMovement({
            product_id: res.product_id,
            type: 'SALE',
            qty_change: -res.qty,
            reason: `Finalized purchase for order ${orderRef}`,
            order_ref: orderRef,
          });
        }
      }

      return true;
    });
  }

  /**
   * Release reservation when checkout expires or is cancelled
   */
  async releaseReservation(orderRef: string, reason: string = 'Checkout cancelled or expired'): Promise<boolean> {
    return this.runExclusive(() => {
      const resList = this.reservations.get(orderRef);
      if (!resList || resList.length === 0) return false;

      const now = new Date().toISOString();
      for (const res of resList) {
        if (res.status === 'HELD') {
          const inv = this.inventory.get(res.product_id);
          if (inv) {
            inv.reserved = Math.max(0, inv.reserved - res.qty);
            inv.updated_at = now;
            this.inventory.set(res.product_id, inv);
          }
          res.status = 'RELEASED';

          this.logMovement({
            product_id: res.product_id,
            type: 'RESERVATION_RELEASE',
            qty_change: res.qty,
            reason: `${reason} for order ${orderRef}`,
            order_ref: orderRef,
          });
        }
      }

      return true;
    });
  }

  /**
   * Admin Restock: +qty and note
   */
  async restock(productId: string, qty: number, note: string, actorId?: string): Promise<Inventory> {
    return this.runExclusive(() => {
      if (qty <= 0) throw new Error('Restock quantity must be greater than zero.');
      let inv = this.inventory.get(productId);
      if (!inv) {
        inv = {
          product_id: productId,
          on_hand: 0,
          reserved: 0,
          low_stock_threshold: 3,
          updated_at: new Date().toISOString(),
        };
      }

      inv.on_hand += qty;
      inv.updated_at = new Date().toISOString();
      this.inventory.set(productId, inv);

      this.logMovement({
        product_id: productId,
        type: 'RESTOCK',
        qty_change: qty,
        reason: note || 'Admin restock',
        actor_id: actorId,
      });

      return { ...inv };
    });
  }

  /**
   * Admin stock adjustment with validation:
   * on_hand can NEVER be set below reserved! (Section 3.5)
   */
  async adjustStock(productId: string, newOnHand: number, reason: string, actorId?: string): Promise<Inventory> {
    return this.runExclusive(() => {
      const inv = this.inventory.get(productId);
      if (!inv) throw new Error(`Product ${productId} not found in inventory.`);
      if (newOnHand < 0) throw new Error('Stock cannot be negative.');
      if (newOnHand < inv.reserved) {
        throw new Error(`Stock cannot be set below active reservations (${inv.reserved} currently held).`);
      }

      const diff = newOnHand - inv.on_hand;
      inv.on_hand = newOnHand;
      inv.updated_at = new Date().toISOString();
      this.inventory.set(productId, inv);

      this.logMovement({
        product_id: productId,
        type: 'ADJUSTMENT',
        qty_change: diff,
        reason: reason || 'Admin manual correction',
        actor_id: actorId,
      });

      return { ...inv };
    });
  }

  async getMovements(productId?: string): Promise<StockMovement[]> {
    if (!productId) return [...this.movements];
    return this.movements.filter((m) => m.product_id === productId);
  }

  private logMovement(entry: Omit<StockMovement, 'id' | 'created_at'>) {
    const movement: StockMovement = {
      ...entry,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    };
    this.movements.unshift(movement);
  }
}

