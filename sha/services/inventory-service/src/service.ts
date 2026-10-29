/**
 * @file services/inventory-service/src/service.ts
 * Inventory Service Business Logic & Availability Projection
 */

import type { Inventory, AvailabilityState, ProductStatus } from '../../../packages/types/src/index.ts';
import type { IInventoryRepository, ReserveItemRequest } from './repository.ts';

export class InventoryService {
  private repo: IInventoryRepository;

  constructor(repo: IInventoryRepository) {
    this.repo = repo;
  }

  async getProductInventory(productId: string) {
    const inv = await this.repo.getInventory(productId);
    if (!inv) return null;
    const available = Math.max(0, inv.on_hand - inv.reserved);
    return {
      ...inv,
      available,
    };
  }

  async getAllInventory() {
    return this.repo.getAllInventory();
  }

  async initializeStock(productId: string, initialOnHand: number, threshold?: number) {
    return this.repo.initProductInventory(productId, initialOnHand, threshold);
  }

  async reserveCart(orderRef: string, items: ReserveItemRequest[]) {
    return this.repo.reserveCart(orderRef, items);
  }

  async finalizeReservation(orderRef: string) {
    return this.repo.finalizeReservation(orderRef);
  }

  async releaseReservation(orderRef: string, reason?: string) {
    return this.repo.releaseReservation(orderRef, reason);
  }

  async restock(productId: string, qty: number, note: string, actorId?: string) {
    return this.repo.restock(productId, qty, note, actorId);
  }

  async adjustStock(productId: string, newOnHand: number, reason: string, actorId?: string) {
    return this.repo.adjustStock(productId, newOnHand, reason, actorId);
  }

  async getMovements(productId?: string) {
    return this.repo.getMovements(productId);
  }
}
