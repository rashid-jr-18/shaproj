/**
 * @file tests/e2e.test.ts
 * Complete End-to-End System Integration Test
 * Simulates complete customer purchase journey and admin fulfillment
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { server, liveOrderService } from '../server.ts';
import { catalogService, catalogRepo } from '../services/catalog-service/src/server.ts';
import { inventoryService } from '../services/inventory-service/src/server.ts';
import { cartService } from '../services/cart-service/src/server.ts';
import { authService } from '../services/auth-service/src/server.ts';

// Helper to make mock HTTP requests directly against server request listener
function mockRequest(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ statusCode: number; headers: Record<string, any>; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as any;
    req.method = method;
    req.url = urlPath;
    req.headers = {
      host: 'localhost:8000',
      ...headers,
    };

    let responseData = '';
    const resHeaders: Record<string, any> = {};
    let statusCode = 200;

    const res = {
      writeHead: (status: number, headersObj: any) => {
        statusCode = status;
        if (headersObj) {
          for (const [k, v] of Object.entries(headersObj)) {
            resHeaders[k.toLowerCase()] = v;
          }
        }
      },
      setHeader: (key: string, val: any) => {
        resHeaders[key.toLowerCase()] = val;
      },
      end: (chunk?: any) => {
        if (chunk) responseData += chunk;
        try {
          const parsed = responseData ? JSON.parse(responseData) : null;
          resolve({ statusCode, headers: resHeaders, body: parsed });
        } catch {
          resolve({ statusCode, headers: resHeaders, body: responseData });
        }
      },
    } as any;

    server.emit('request', req, res);

    process.nextTick(() => {
      if (body) {
        req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
      }
      req.emit('end');
    });
  });
}

describe('Hira Complete End-to-End System Tests', () => {
  it('should wait for catalog seeding to complete', async () => {
    // Give async seeder a moment to load all 50 items
    for (let i = 0; i < 20; i++) {
      const { total } = await catalogRepo.getProducts({ limit: 100 });
      if (total >= 50) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const { total } = await catalogRepo.getProducts({ limit: 100 });
    assert.strictEqual(total, 50, 'All 50 products should be loaded in catalog');
  });

  it('should verify platform health and security headers', async () => {
    const res = await mockRequest('GET', '/health');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'UP');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
  });

  it('should serve customer catalog with all 50 items and live stock', async () => {
    const res = await mockRequest('GET', '/api/v1/products?limit=50');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.length, 50, 'All 50 products should be listed');
    assert.ok(res.body.data[0].available_stock > 0);
  });

  it('should execute full Customer Purchase -> Store Owner Delivery Saga', async () => {
    // 1. Customer adds 2 Cotton Kurtas to cart
    const kurta = await catalogRepo.getProductBySlug('pure-cotton-handblock-kurta-peacock-blue');
    assert.ok(kurta);
    const cartId = 'e2e-customer-cart-01';

    const addCartRes = await mockRequest(
      'POST',
      '/api/v1/cart/items',
      { 'x-cart-id': cartId },
      {
        product_id: kurta.id,
        sku: kurta.sku,
        name: kurta.name,
        price: kurta.price,
        qty: 2,
      }
    );
    assert.strictEqual(addCartRes.statusCode, 200);
    assert.strictEqual(addCartRes.body.data.items.length, 1);
    assert.strictEqual(addCartRes.body.data.subtotal, kurta.price * 2);

    // 2. Customer places order via Checkout Saga with Idempotency Key
    const orderRes = await mockRequest(
      'POST',
      '/api/v1/orders',
      {
        'idempotency-key': 'idem-e2e-saga-001',
        'x-cart-id': cartId,
      },
      {
        userId: 'customer-e2e-id',
        items: [{ productId: kurta.id, qty: 2 }],
        address: {
          name: 'Sundar Pichai',
          phone: '+919876500000',
          line1: '1600 Amphitheatre Parkway',
          city: 'Chennai',
          state: 'Tamil Nadu',
          pincode: '600001',
        },
        paymentMethod: 'COD', // Direct confirmation for COD
      }
    );

    assert.strictEqual(orderRes.statusCode, 201);
    const order = orderRes.body.data;
    assert.ok(order.order_no);
    assert.strictEqual(order.status, 'CONFIRMED');

    // 3. Store Owner logs in with 2FA
    const admin2fa = authService.getAdminCurrentTotp('00000000-0000-0000-0000-000000000001');
    const loginRes = await mockRequest(
      'POST',
      '/api/v1/auth/login',
      {},
      {
        email: 'admin@hira.in',
        password: 'HiraAdminSecure2026!',
        totpCode: admin2fa,
      }
    );
    assert.strictEqual(loginRes.statusCode, 200);
    const adminToken = loginRes.body.data.accessToken;
    assert.ok(adminToken);

    // 4. Store Owner sees order and starts packing
    const packRes = await mockRequest(
      'POST',
      `/api/v1/admin/orders/${order.id}/process`,
      { authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(packRes.statusCode, 200);
    assert.strictEqual(packRes.body.data.status, 'PROCESSING');

    // 5. Store Owner ships with courier name and tracking number
    const shipRes = await mockRequest(
      'POST',
      `/api/v1/admin/orders/${order.id}/ship`,
      { authorization: `Bearer ${adminToken}` },
      { courierName: 'Delhivery Surface', trackingNumber: 'DLH-IND-99124' }
    );
    assert.strictEqual(shipRes.statusCode, 200);
    assert.strictEqual(shipRes.body.data.status, 'SHIPPED');

    // 6. Courier delivers package
    const deliverRes = await mockRequest(
      'POST',
      `/api/v1/admin/orders/${order.id}/deliver`,
      { authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(deliverRes.statusCode, 200);
    assert.strictEqual(deliverRes.body.data.status, 'DELIVERED');

    // 7. Store Owner restocks product (+15 units)
    const restockRes = await mockRequest(
      'POST',
      `/api/v1/admin/inventory/${kurta.id}/restock`,
      { authorization: `Bearer ${adminToken}` },
      { qty: 15, note: 'Received weaver consignment batch #44' }
    );
    assert.strictEqual(restockRes.statusCode, 200);
    assert.ok(restockRes.body.data.on_hand > 15);
  });

  it('should authenticate user automatically via Google Sign-In endpoint', async () => {
    const googleRes = await mockRequest(
      'POST',
      '/api/v1/auth/google',
      {},
      {
        email: 'raseed@gmail.com',
        name: 'Raseed',
        googleId: 'goog-test-999',
      }
    );

    assert.strictEqual(googleRes.statusCode, 200);
    assert.strictEqual(googleRes.body.success, true);
    assert.ok(googleRes.body.data.accessToken);
    assert.strictEqual(googleRes.body.data.user.email, 'raseed@gmail.com');
    assert.strictEqual(googleRes.body.data.user.name, 'Raseed');
    assert.strictEqual(googleRes.body.data.user.role, 'CUSTOMER');
  });

  it('should add new product end-to-end via POST /api/v1/admin/products and reflect in customer catalog', async () => {
    // 1. Store Owner adds product
    const admin2fa = authService.getAdminCurrentTotp('00000000-0000-0000-0000-000000000001');
    const loginRes = await mockRequest('POST', '/api/v1/auth/login', {}, {
      email: 'admin@hira.in',
      password: 'HiraAdminSecure2026!',
      totpCode: admin2fa,
    });
    const adminToken = loginRes.body.data.accessToken;

    const newProdSku = `HRA-TST-${Date.now().toString().slice(-4)}`;
    const addProdRes = await mockRequest(
      'POST',
      '/api/v1/admin/products',
      { authorization: `Bearer ${adminToken}` },
      {
        name: 'Handcrafted Terracotta Chai Jug',
        sku: newProdSku,
        categoryName: 'Kitchen',
        price: 89900, // ₹899
        mrp: 129900,  // ₹1,299
        tax_rate: 12,
        description: 'Authentic clay beverage jug.',
        imageUrl: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd',
        initialStock: 25,
        lowStockThreshold: 4,
      }
    );

    assert.strictEqual(addProdRes.statusCode, 201);
    assert.strictEqual(addProdRes.body.data.sku, newProdSku);
    const createdId = addProdRes.body.data.id;

    // 2. Product immediately reflects in customer listing with live stock
    const catRes = await mockRequest('GET', '/api/v1/products?limit=100');
    assert.strictEqual(catRes.statusCode, 200);
    const found = catRes.body.data.find((p: any) => p.sku === newProdSku);
    assert.ok(found, 'New product must be visible in customer catalog');
    assert.strictEqual(found.available_stock, 25, 'Initial stock must be accurately initialized');
    assert.strictEqual(found.price, 89900);
  });

  it('should serve private /owner portal route', async () => {
    const ownerPageRes = await mockRequest('GET', '/owner');
    assert.strictEqual(ownerPageRes.statusCode, 200);
    assert.strictEqual(ownerPageRes.headers['content-type'], 'text/html');
    assert.ok(typeof ownerPageRes.body === 'string' && ownerPageRes.body.includes('Hira Store Owner'));
  });

  it('should execute complete Swiggy/Zomato Mobile OTP journey (Send OTP -> Verify -> Login)', async () => {
    const customerPhone = '9876543210';

    // 1. Send OTP
    const sendRes = await mockRequest(
      'POST',
      '/api/v1/auth/mobile/send-otp',
      {},
      { phone: customerPhone }
    );
    assert.strictEqual(sendRes.statusCode, 200);
    assert.strictEqual(sendRes.body.success, true);
    const demoOtp = sendRes.body.data.demoOtp;
    assert.ok(demoOtp);

    // 2. Verify OTP
    const verifyRes = await mockRequest(
      'POST',
      '/api/v1/auth/mobile/verify-otp',
      {},
      {
        phone: customerPhone,
        otp: demoOtp,
        name: 'Raseed',
      }
    );
    assert.strictEqual(verifyRes.statusCode, 200);
    assert.strictEqual(verifyRes.body.success, true);
    assert.ok(verifyRes.body.data.accessToken);
    assert.strictEqual(verifyRes.body.data.user.phone, `+91${customerPhone}`);
  });

  it('should authenticate user via Firebase verified mobile endpoint (POST /api/v1/auth/firebase/verify)', async () => {
    const fbPhone = '9988776655';
    const res = await mockRequest(
      'POST',
      '/api/v1/auth/firebase/verify',
      {},
      {
        phone: fbPhone,
        name: 'Raseed Firebase E2E',
      }
    );
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.data.accessToken);
    assert.strictEqual(res.body.data.user.phone, `+91${fbPhone}`);
    assert.strictEqual(res.body.data.user.name, 'Raseed Firebase E2E');
  });
});
