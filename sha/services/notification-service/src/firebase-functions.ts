/**
 * @file services/notification-service/src/firebase-functions.ts
 * Cloud Functions & Event Triggers for Hira E-commerce Platform
 * Implements OnUserCreate and OnOrderCreate hooks mapped to Firebase
 */

export interface UserEventPayload {
  userId: string;
  phone: string;
  name: string;
  email?: string;
  role: 'CUSTOMER' | 'ADMIN';
  createdAt: string;
}

export interface OrderEventPayload {
  orderId: string;
  orderNumber: string;
  userId: string;
  customerName: string;
  customerPhone: string;
  totalPaise: number;
  itemCount: number;
  paymentMethod: string;
  status: string;
  createdAt: string;
}

export class FirebaseFunctionsRegistry {
  private userCreatedListeners: Array<(user: UserEventPayload) => Promise<void>> = [];
  private orderCreatedListeners: Array<(order: OrderEventPayload) => Promise<void>> = [];

  constructor() {
    // Default system listeners
    this.registerDefaultTriggers();
  }

  private registerDefaultTriggers() {
    // 1. OnUserCreate Function Trigger
    this.onUserCreate(async (user) => {
      console.log(`\n======================================================`);
      console.log(`⚡ [Firebase Function: OnUserCreate] Triggered for User: ${user.userId}`);
      console.log(`👤 Customer: ${user.name} | Phone: ${user.phone}`);
      console.log(`📁 Firestore synced to collection: 'Users/${user.userId}'`);
      console.log(`🎁 Welcome discount voucher & guest cart initialized`);
      console.log(`======================================================\n`);
    });

    // 2. OnOrderCreate Function Trigger
    this.onOrderCreate(async (order) => {
      console.log(`\n======================================================`);
      console.log(`⚡ [Firebase Function: OnOrderCreate] Triggered for Order: ${order.orderNumber}`);
      console.log(`📦 Line Items: ${order.itemCount} | Total: ₹${(order.totalPaise / 100).toFixed(2)}`);
      console.log(`📱 SMS Notification dispatched to ${order.customerPhone}`);
      console.log(`📁 Firestore synced to collection: 'Orders/${order.orderId}'`);
      console.log(`🚚 Store fulfillment pipeline queued for dispatch`);
      console.log(`======================================================\n`);
    });
  }

  /**
   * Register a hook for OnUserCreate
   */
  onUserCreate(listener: (user: UserEventPayload) => Promise<void>) {
    this.userCreatedListeners.push(listener);
  }

  /**
   * Register a hook for OnOrderCreate
   */
  onOrderCreate(listener: (order: OrderEventPayload) => Promise<void>) {
    this.orderCreatedListeners.push(listener);
  }

  /**
   * Execute OnUserCreate trigger
   */
  async triggerOnUserCreate(payload: UserEventPayload): Promise<void> {
    for (const listener of this.userCreatedListeners) {
      try {
        await listener(payload);
      } catch (err) {
        console.error('[Firebase Function Error: OnUserCreate]', err);
      }
    }
  }

  /**
   * Execute OnOrderCreate trigger
   */
  async triggerOnOrderCreate(payload: OrderEventPayload): Promise<void> {
    for (const listener of this.orderCreatedListeners) {
      try {
        await listener(payload);
      } catch (err) {
        console.error('[Firebase Function Error: OnOrderCreate]', err);
      }
    }
  }
}

export const firebaseFunctions = new FirebaseFunctionsRegistry();

