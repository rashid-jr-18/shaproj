/**
 * @file packages/config/src/index.ts
 * Hira Environment & Application Default Configuration
 */

export const HIRA_CONFIG = {
  appName: 'Hira',
  currency: 'INR',
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
  defaultPageLimit: 20,
  maxPageLimit: 100,
  stockReservationMinutes: 15,
  codLimitPaise: 500000, // ₹5,000 max for Cash on Delivery
  freeShippingThresholdPaise: 99900, // ₹999 free shipping threshold
  standardShippingFeePaise: 5000, // ₹50 standard shipping fee
  jwt: {
    accessTokenExpiresInSec: 900, // 15 minutes
    refreshTokenExpiresInSec: 2592000, // 30 days
  },
  ports: {
    gateway: 8000,
    authService: 3001,
    catalogService: 3002,
    inventoryService: 3003,
    cartService: 3004,
    orderService: 3005,
    paymentService: 3006,
    notificationService: 3007,
    webApp: 3000,
    adminApp: 3008,
  },
} as const;

