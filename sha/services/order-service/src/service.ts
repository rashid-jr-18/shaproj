/**
 * @file services/order-service/src/service.ts
 * Order Service Business Logic & Checkout Saga Orchestration
 */

import * as crypto from 'node:crypto';
import type {
  Order,
  OrderItem,
  OrderStatus,
  PaymentMethod,
  AddressSnapshot,
} from '../../../packages/types/src/index.ts';
import { validateTransition, canCustomerCancel } from './state-machine.ts';
import type { IOrderRepository } from './repository.ts';

export interface CheckoutItemInput {
  productId: string;
  qty: number;
}

export interface CreateOrderInput {
  userId: string;
  items: CheckoutItemInput[];
  address: AddressSnapshot;
  paymentMethod: PaymentMethod;
  idempotencyKey: string;
}

export interface CatalogLookupItem {
  id: string;
  sku: string;
  name: string;
  price: number; // paise
  tax_rate: number;
  status: string;
}

export class OrderService {
  private repo: IOrderRepository;
  
  // Service-to-service sync adapters
  private catalogLookup: (productId: string) => Promise<CatalogLookupItem | null>;
  private inventoryReserve: (orderRef: string, items: Array<{ productId: string; qty: number }>) => Promise<{ success: boolean; failedProductId?: string }>;
  private inventoryFinalize: (orderRef: string) => Promise<boolean>;
  private inventoryRelease: (orderRef: string, reason?: string) => Promise<boolean>;

  constructor(
    repo: IOrderRepository,
    adapters: {
      catalogLookup: (productId: string) => Promise<CatalogLookupItem | null>;
      inventoryReserve: (orderRef: string, items: Array<{ productId: string; qty: number }>) => Promise<{ success: boolean; failedProductId?: string }>;
      inventoryFinalize: (orderRef: string) => Promise<boolean>;
      inventoryRelease: (orderRef: string, reason?: string) => Promise<boolean>;
    }
  ) {
    this.repo = repo;
    this.catalogLookup = adapters.catalogLookup;
    this.inventoryReserve = adapters.inventoryReserve;
    this.inventoryFinalize = adapters.inventoryFinalize;
    this.inventoryRelease = adapters.inventoryRelease;
  }

  /**
   * Section 6.2: Checkout Saga
   */
  async placeOrder(input: CreateOrderInput): Promise<Order> {
    if (!input.idempotencyKey) {
      throw new Error('Idempotency-Key is required for order creation.');
    }

    // 1. Check idempotency: Replay prevention (Section 7.1)
    const existingOrder = await this.repo.getByIdempotencyKey(input.idempotencyKey);
    if (existingOrder) {
      return existingOrder;
    }

    if (!input.items || input.items.length === 0) {
      throw new Error('Order must contain at least one item.');
    }

    // 2. Server re-calculates all prices & snapshots product details (Never trust client! Section 18 #1)
    let subtotal = 0;
    let totalTax = 0;
    const orderItems: Omit<OrderItem, 'id' | 'order_id'>[] = [];
    const reserveItems: Array<{ productId: string; qty: number }> = [];

    for (const itemInput of input.items) {
      if (itemInput.qty <= 0) throw new Error('Invalid quantity in order.');

      const product = await this.catalogLookup(itemInput.productId);
      if (!product || product.status !== 'ACTIVE') {
        throw new Error(`Product ${itemInput.productId} is not available for purchase.`);
      }

      const lineSubtotal = product.price * itemInput.qty;
      const lineTax = Math.round((lineSubtotal * product.tax_rate) / 100);

      subtotal += lineSubtotal;
      totalTax += lineTax;

      orderItems.push({
        product_id: product.id,
        sku_snapshot: product.sku,
        name_snapshot: product.name,
        unit_price_snapshot: product.price,
        qty: itemInput.qty,
        line_total: lineSubtotal,
      });

      reserveItems.push({
        productId: product.id,
        qty: itemInput.qty,
      });
    }

    // Shipping rules: Free shipping if subtotal >= ₹999 (99900 paise), else ₹50 (5000 paise)
    const shippingFee = subtotal >= 99900 ? 0 : 5000;
    const discount = 0;
    const grandTotal = subtotal + totalTax + shippingFee - discount;

    // COD Validation: limit to ₹5,000 (500000 paise)
    if (input.paymentMethod === 'COD' && grandTotal > 500000) {
      throw new Error('Cash on Delivery is limited to orders up to ₹5,000.');
    }

    const orderNo = `HRA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    // 3. Sync Call to inventory-service: Reserve all items atomically (Section 6.2 #3)
    const reservation = await this.inventoryReserve(orderNo, reserveItems);
    if (!reservation.success) {
      throw new Error(`Cannot place order: Product ${reservation.failedProductId} is out of stock.`);
    }

    // 4. Create Order
    // COD orders skip PENDING_PAYMENT and go straight to CONFIRMED (Section 6.1)
    const initialStatus: OrderStatus = input.paymentMethod === 'COD' ? 'CONFIRMED' : 'PENDING_PAYMENT';

    const order = await this.repo.createOrder(
      {
        id: crypto.randomUUID(),
        order_no: orderNo,
        user_id: input.userId,
        status: initialStatus,
        subtotal,
        tax: totalTax,
        shipping_fee: shippingFee,
        discount,
        total: grandTotal,
        address_snapshot: input.address,
        payment_method: input.paymentMethod,
        idempotency_key: input.idempotencyKey,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      orderItems
    );

    return order;
  }

  /**
   * Called when payment succeeds (e.g. from Razorpay webhook)
   */
  async confirmPayment(orderId: string): Promise<Order> {
    const order = await this.repo.getOrderById(orderId);
    if (!order) throw new Error('Order not found.');

    if (order.status === 'CONFIRMED') {
      return order; // Already confirmed, idempotent
    }

    validateTransition(order.status, 'CONFIRMED');

    // Finalize stock reservation in inventory-service
    await this.inventoryFinalize(order.order_no);

    return this.repo.updateOrderStatus(orderId, 'CONFIRMED', 'payment-gateway', 'Payment confirmed via webhook');
  }

  /**
   * Admin: Start Processing
   */
  async startProcessing(orderId: string, adminId: string): Promise<Order> {
    const order = await this.repo.getOrderById(orderId);
    if (!order) throw new Error('Order not found.');
    validateTransition(order.status, 'PROCESSING');
    return this.repo.updateOrderStatus(orderId, 'PROCESSING', adminId, 'Fulfillment started');
  }

  /**
   * Admin: Mark as Shipped
   */
  async markAsShipped(orderId: string, courierName: string, trackingNumber: string, adminId: string): Promise<Order> {
    const order = await this.repo.getOrderById(orderId);
    if (!order) throw new Error('Order not found.');
    validateTransition(order.status, 'SHIPPED');
    const note = `Shipped via ${courierName} (Tracking #${trackingNumber})`;
    return this.repo.updateOrderStatus(orderId, 'SHIPPED', adminId, note);
  }

  /**
   * Mark as Delivered
   */
  async markAsDelivered(orderId: string, actorId?: string): Promise<Order> {
    const order = await this.repo.getOrderById(orderId);
    if (!order) throw new Error('Order not found.');
    validateTransition(order.status, 'DELIVERED');
    return this.repo.updateOrderStatus(orderId, 'DELIVERED', actorId, 'Package delivered successfully');
  }

  /**
   * Customer / Admin Cancellation (Before shipping)
   */
  async cancelOrder(orderId: string, reason: string, actorId?: string): Promise<Order> {
    const order = await this.repo.getOrderById(orderId);
    if (!order) throw new Error('Order not found.');

    if (!canCustomerCancel(order.status)) {
      throw new Error(`Order cannot be cancelled in state ${order.status}. Return after delivery.`);
    }

    validateTransition(order.status, 'CANCELLED');

    // Release held stock reservation
    await this.inventoryRelease(order.order_no, reason);

    return this.repo.updateOrderStatus(orderId, 'CANCELLED', actorId, `Cancelled: ${reason}`);
  }

  /**
   * Customer Return Request (After delivery)
   */
  async requestReturn(orderId: string, reason: string, userId: string) {
    const order = await this.repo.getOrderById(orderId);
    if (!order || order.user_id !== userId) throw new Error('Order not found or unauthorized.');
    if (order.status !== 'DELIVERED') throw new Error('Only delivered orders can be returned.');

    validateTransition(order.status, 'RETURN_REQUESTED');
    await this.repo.updateOrderStatus(orderId, 'RETURN_REQUESTED', userId, `Return requested: ${reason}`);
    return this.repo.createReturn(orderId, reason, order.total);
  }

  async getOrder(orderId: string, userId?: string) {
    const order = await this.repo.getOrderById(orderId);
    if (!order) return null;
    if (userId && order.user_id !== userId) return null; // IDOR check
    return order;
  }

  async getUserOrders(userId: string) {
    return this.repo.getUserOrders(userId);
  }

  async getAllOrders(status?: OrderStatus, search?: string) {
    return this.repo.getAllOrders(status, search);
  }

  async getStatusHistory(orderId: string) {
    return this.repo.getStatusHistory(orderId);
  }
}

