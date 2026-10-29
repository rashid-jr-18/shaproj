/**
 * @file services/order-service/src/repository.ts
 * Order Service Repository with Idempotency Key Tracking & Audit History
 */

import * as crypto from 'node:crypto';
import type {
  Order,
  OrderItem,
  OrderStatusHistory,
  OrderReturn,
  OrderStatus,
} from '../../../packages/types/src/index.ts';

export interface IOrderRepository {
  createOrder(order: Order, items: Omit<OrderItem, 'id' | 'order_id'>[]): Promise<Order>;
  getOrderById(id: string): Promise<Order | null>;
  getOrderByOrderNo(orderNo: string): Promise<Order | null>;
  getByIdempotencyKey(key: string): Promise<Order | null>;
  getUserOrders(userId: string): Promise<Order[]>;
  getAllOrders(status?: OrderStatus, search?: string): Promise<Order[]>;
  
  updateOrderStatus(orderId: string, toStatus: OrderStatus, actorId?: string, note?: string): Promise<Order>;
  getStatusHistory(orderId: string): Promise<OrderStatusHistory[]>;

  createReturn(orderId: string, reason: string, refundAmount: number): Promise<OrderReturn>;
  getReturns(orderId?: string): Promise<OrderReturn[]>;
}

export class InMemoryOrderRepository implements IOrderRepository {
  private orders = new Map<string, Order>();
  private orderItems = new Map<string, OrderItem[]>(); // orderId -> items
  private statusHistory: OrderStatusHistory[] = [];
  private returns: OrderReturn[] = [];
  private idempotencyMap = new Map<string, string>(); // idempotencyKey -> orderId

  async createOrder(orderData: Order, items: Omit<OrderItem, 'id' | 'order_id'>[]): Promise<Order> {
    const orderId = orderData.id || crypto.randomUUID();
    const now = new Date().toISOString();

    const order: Order = {
      ...orderData,
      id: orderId,
      created_at: now,
      updated_at: now,
    };

    const createdItems: OrderItem[] = items.map((item) => ({
      ...item,
      id: crypto.randomUUID(),
      order_id: orderId,
    }));

    this.orders.set(orderId, order);
    this.orderItems.set(orderId, createdItems);

    if (order.idempotency_key) {
      this.idempotencyMap.set(order.idempotency_key, orderId);
    }

    // Log initial status
    this.statusHistory.push({
      id: crypto.randomUUID(),
      order_id: orderId,
      from_status: order.status,
      to_status: order.status,
      note: 'Order initiated',
      created_at: now,
    });

    return { ...order, items: createdItems };
  }

  async getOrderById(id: string): Promise<Order | null> {
    const o = this.orders.get(id);
    if (!o) return null;
    return {
      ...o,
      items: this.orderItems.get(id) || [],
    };
  }

  async getOrderByOrderNo(orderNo: string): Promise<Order | null> {
    for (const o of this.orders.values()) {
      if (o.order_no === orderNo) {
        return {
          ...o,
          items: this.orderItems.get(o.id) || [],
        };
      }
    }
    return null;
  }

  async getByIdempotencyKey(key: string): Promise<Order | null> {
    const orderId = this.idempotencyMap.get(key);
    if (!orderId) return null;
    return this.getOrderById(orderId);
  }

  async getUserOrders(userId: string): Promise<Order[]> {
    const list: Order[] = [];
    for (const o of this.orders.values()) {
      if (o.user_id === userId) {
        list.push({ ...o, items: this.orderItems.get(o.id) || [] });
      }
    }
    return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  async getAllOrders(status?: OrderStatus, search?: string): Promise<Order[]> {
    let list = Array.from(this.orders.values()).map((o) => ({
      ...o,
      items: this.orderItems.get(o.id) || [],
    }));

    if (status) {
      list = list.filter((o) => o.status === status);
    }

    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter((o) => o.order_no.toLowerCase().includes(q) || o.address_snapshot.phone.includes(q));
    }

    return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  async updateOrderStatus(orderId: string, toStatus: OrderStatus, actorId?: string, note?: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);

    const fromStatus = order.status;
    order.status = toStatus;
    order.updated_at = new Date().toISOString();
    this.orders.set(orderId, order);

    this.statusHistory.push({
      id: crypto.randomUUID(),
      order_id: orderId,
      from_status: fromStatus,
      to_status: toStatus,
      actor_id: actorId,
      note,
      created_at: new Date().toISOString(),
    });

    return {
      ...order,
      items: this.orderItems.get(orderId) || [],
    };
  }

  async getStatusHistory(orderId: string): Promise<OrderStatusHistory[]> {
    return this.statusHistory.filter((h) => h.order_id === orderId);
  }

  async createReturn(orderId: string, reason: string, refundAmount: number): Promise<OrderReturn> {
    const ret: OrderReturn = {
      id: crypto.randomUUID(),
      order_id: orderId,
      reason,
      status: 'REQUESTED',
      refund_amount: refundAmount,
      created_at: new Date().toISOString(),
    };
    this.returns.push(ret);
    return ret;
  }

  async getReturns(orderId?: string): Promise<OrderReturn[]> {
    if (!orderId) return [...this.returns];
    return this.returns.filter((r) => r.order_id === orderId);
  }
}

