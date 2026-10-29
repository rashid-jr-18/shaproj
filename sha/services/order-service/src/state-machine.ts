/**
 * @file services/order-service/src/state-machine.ts
 * Order State Machine & Allowed Transitions Validator
 */

import type { OrderStatus } from '../../../packages/types/src/index.ts';

// Allowed transitions mapping
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURN_APPROVED', 'DELIVERED'], // Approved or rejected
  RETURN_APPROVED: ['RETURNED'],
  RETURNED: ['REFUNDED'],
  CANCELLED: [], // Terminal state
  REFUNDED: [],  // Terminal state
};

export function canTransitionOrder(fromStatus: OrderStatus, toStatus: OrderStatus): boolean {
  if (fromStatus === toStatus) return true;
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

export function validateTransition(fromStatus: OrderStatus, toStatus: OrderStatus): void {
  if (!canTransitionOrder(fromStatus, toStatus)) {
    throw new Error(`Illegal order state transition from ${fromStatus} to ${toStatus}.`);
  }
}

/**
 * Checks if a customer is allowed to cancel an order directly.
 * Rule: Customer can cancel only before shipping (PENDING_PAYMENT, CONFIRMED, PROCESSING).
 * After SHIPPED, customer must use returns.
 */
export function canCustomerCancel(status: OrderStatus): boolean {
  return status === 'PENDING_PAYMENT' || status === 'CONFIRMED' || status === 'PROCESSING';
}

