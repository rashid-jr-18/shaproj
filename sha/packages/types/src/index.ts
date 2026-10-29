/**
 * @file packages/types/src/index.ts
 * Hira E-commerce Application - Shared Domain Types, Event Contracts & API DTOs
 */

// ==========================================
// 1. Core Enumerations & Literals
// ==========================================

export type UserRole = 'CUSTOMER' | 'ADMIN';

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'LOCKED';

export type ProductStatus = 'ACTIVE' | 'UNAVAILABLE' | 'ARCHIVED';

export type AvailabilityState = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE' | 'ARCHIVED';

export type ReservationStatus = 'HELD' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED';

export type StockMovementType =
  | 'INITIAL'
  | 'SALE'
  | 'RESTOCK'
  | 'ADJUSTMENT'
  | 'RETURN_RESTOCK'
  | 'RETURN_WRITEOFF'
  | 'ORDER_CANCELLED'
  | 'RESERVATION_HOLD'
  | 'RESERVATION_RELEASE';

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'RETURN_REQUESTED'
  | 'RETURN_APPROVED'
  | 'RETURNED'
  | 'REFUNDED';

export type PaymentMethod = 'RAZORPAY' | 'COD';

export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'REFUNDED';

export type RefundStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

export type ReturnStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'RECEIVED' | 'REFUNDED';

// ==========================================
// 2. Domain Models (Database-per-service mirrors)
// ==========================================

// --- Auth Service Models ---
export interface User {
  id: string; // UUID
  name: string;
  email: string;
  phone: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  email_verified_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Address {
  id: string; // UUID
  user_id: string;
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  is_default: boolean;
  created_at: string;
}

export interface RefreshToken {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  device_info?: string;
}

// --- Catalog Service Models ---
export interface Category {
  id: string;
  name: string;
  slug: string;
  parent_id?: string | null;
  created_at: string;
}

export interface ProductImage {
  id: string;
  product_id: string;
  url: string;
  alt: string;
  sort_order: number;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  slug: string;
  description: string;
  category_id: string;
  price: number; // Integer paise (e.g., 49950 for ₹499.50)
  mrp: number;   // Integer paise
  tax_rate: number; // Percentage, e.g. 5, 12, 18
  status: ProductStatus;
  images?: ProductImage[];
  category?: Category;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

// Catalog View Model (Product + Live Inventory Projection)
export interface CatalogProductView extends Product {
  availability: AvailabilityState;
  available_stock: number;
}

// --- Inventory Service Models ---
export interface Inventory {
  product_id: string; // PK
  on_hand: number;    // Physically in stock
  reserved: number;   // In checkout or unpaid orders
  low_stock_threshold: number; // default 3
  updated_at: string;
}

export interface Reservation {
  id: string;
  order_ref: string;
  product_id: string;
  qty: number;
  status: ReservationStatus;
  expires_at: string;
  created_at: string;
}

export interface StockMovement {
  id: string;
  product_id: string;
  type: StockMovementType;
  qty_change: number;
  reason?: string;
  actor_id?: string;
  order_ref?: string;
  created_at: string;
}

// --- Cart Service Models ---
export interface CartItem {
  product_id: string;
  sku: string;
  name: string;
  price: number; // in paise
  qty: number;
  image_url?: string;
}

export interface Cart {
  id: string; // sessionId for guest, or userId for logged-in
  user_id?: string | null;
  items: CartItem[];
  subtotal: number; // calculated in paise
  updated_at: string;
}

// --- Order Service Models ---
export interface AddressSnapshot {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  name_snapshot: string;
  sku_snapshot: string;
  unit_price_snapshot: number; // integer paise
  qty: number;
  line_total: number;         // unit_price * qty in paise
}

export interface Order {
  id: string;
  order_no: string;           // Human readable, e.g. HRA-20261029-XXXX
  user_id: string;
  status: OrderStatus;
  subtotal: number;          // integer paise
  tax: number;               // integer paise
  shipping_fee: number;      // integer paise
  discount: number;          // integer paise
  total: number;             // integer paise
  address_snapshot: AddressSnapshot;
  payment_method: PaymentMethod;
  idempotency_key: string;
  items?: OrderItem[];
  created_at: string;
  updated_at: string;
}

export interface OrderStatusHistory {
  id: string;
  order_id: string;
  from_status: OrderStatus;
  to_status: OrderStatus;
  actor_id?: string;
  note?: string;
  created_at: string;
}

export interface OrderReturn {
  id: string;
  order_id: string;
  reason: string;
  status: ReturnStatus;
  refund_amount: number; // paise
  created_at: string;
}

// --- Payment Service Models ---
export interface Payment {
  id: string;
  order_id: string;
  gateway: 'RAZORPAY' | 'COD';
  gateway_payment_id?: string;
  gateway_order_id?: string;
  amount: number; // paise
  currency: 'INR';
  status: PaymentStatus;
  method?: string;
  created_at: string;
}

export interface Refund {
  id: string;
  payment_id: string;
  amount: number; // paise
  status: RefundStatus;
  reason: string;
  created_at: string;
}

export interface WebhookEvent {
  id: string;
  gateway_event_id: string;
  payload: Record<string, any>;
  processed_at: string;
}

// ==========================================
// 3. Event Contracts (RabbitMQ Topics)
// ==========================================

export interface BaseDomainEvent<T = any> {
  eventId: string;
  eventType: string;
  timestamp: string;
  correlationId: string;
  payload: T;
}

export type OrderCreatedEvent = BaseDomainEvent<{
  orderId: string;
  orderNo: string;
  userId: string;
  total: number;
  paymentMethod: PaymentMethod;
  items: Array<{ productId: string; qty: number; unitPrice: number }>;
}>;

export type OrderConfirmedEvent = BaseDomainEvent<{
  orderId: string;
  orderNo: string;
  userId: string;
  total: number;
  paymentId?: string;
}>;

export type OrderShippedEvent = BaseDomainEvent<{
  orderId: string;
  orderNo: string;
  courierName: string;
  trackingNumber: string;
}>;

export type OrderDeliveredEvent = BaseDomainEvent<{
  orderId: string;
  orderNo: string;
}>;

export type OrderCancelledEvent = BaseDomainEvent<{
  orderId: string;
  orderNo: string;
  reason: string;
  items: Array<{ productId: string; qty: number }>;
}>;

export type PaymentSucceededEvent = BaseDomainEvent<{
  paymentId: string;
  orderId: string;
  amount: number;
  gatewayPaymentId: string;
}>;

export type PaymentFailedEvent = BaseDomainEvent<{
  orderId: string;
  reason: string;
}>;

export type StockReservedEvent = BaseDomainEvent<{
  orderRef: string;
  items: Array<{ productId: string; qty: number }>;
}>;

export type StockReleasedEvent = BaseDomainEvent<{
  orderRef: string;
  items: Array<{ productId: string; qty: number }>;
}>;

export type StockLowEvent = BaseDomainEvent<{
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
  threshold: number;
}>;

export type StockOutEvent = BaseDomainEvent<{
  productId: string;
}>;

export type ProductAvailabilityChangedEvent = BaseDomainEvent<{
  productId: string;
  previousStatus: ProductStatus;
  newStatus: ProductStatus;
}>;

// ==========================================
// 4. API Standard Contract & Error Responses
// ==========================================

export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    hasMore?: boolean;
  };
  correlationId: string;
}

export interface ApiErrorResponse {
  success: false;
  code: string;
  message: string;
  details?: Record<string, any>;
  correlationId: string;
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

// Standard Error Codes
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CONFLICT: 'CONFLICT',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  STOCK_RESERVATION_FAILED: 'STOCK_RESERVATION_FAILED',
  PRICE_CHANGED: 'PRICE_CHANGED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
} as const;

