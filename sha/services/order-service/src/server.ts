/**
 * @file services/order-service/src/server.ts
 * Order Service HTTP Server
 */

import * as http from 'node:http';
import { InMemoryOrderRepository } from './repository.ts';
import { OrderService } from './service.ts';

const PORT = Number(process.env.PORT) || 3005;
export const orderRepo = new InMemoryOrderRepository();

// In production, these adapters communicate over HTTP/gRPC with the other microservices
export const orderService = new OrderService(orderRepo, {
  catalogLookup: async (productId) => {
    // Fallback adapter or HTTP call to catalog-service
    return {
      id: productId,
      sku: 'HRA-SKU-DEMO',
      name: 'Hira Handcrafted Item',
      price: 149900,
      tax_rate: 5,
      status: 'ACTIVE',
    };
  },
  inventoryReserve: async (orderRef, items) => {
    // In dev / standalone, succeeds
    return { success: true };
  },
  inventoryFinalize: async (orderRef) => true,
  inventoryRelease: async (orderRef) => true,
});

function sendJson(res: http.ServerResponse, statusCode: number, data: any, correlationId: string) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId,
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

export const orderRequestListener: http.RequestListener = async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr-${Date.now()}`;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id, Idempotency-Key');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/health' || pathname === '/ready') {
      sendJson(res, 200, { status: 'UP', service: 'order-service' }, correlationId);
      return;
    }

    // POST /api/v1/orders (Place Order)
    if (pathname === '/api/v1/orders' && method === 'POST') {
      const idempotencyKey = (req.headers['idempotency-key'] as string) || '';
      if (!idempotencyKey) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'Idempotency-Key header is required.' }, correlationId);
        return;
      }
      const body = await parseJsonBody(req);
      const order = await orderService.placeOrder({
        ...body,
        idempotencyKey,
      });
      sendJson(res, 201, { success: true, data: order, correlationId }, correlationId);
      return;
    }

    // GET /api/v1/orders (Customer orders)
    if (pathname === '/api/v1/orders' && method === 'GET') {
      const userId = (req.headers['x-user-id'] as string) || url.searchParams.get('userId') || 'user-default';
      const orders = await orderService.getUserOrders(userId);
      sendJson(res, 200, { success: true, data: orders, correlationId }, correlationId);
      return;
    }

    // Admin: GET /api/v1/admin/orders
    if (pathname === '/api/v1/admin/orders' && method === 'GET') {
      const status = (url.searchParams.get('status') as any) || undefined;
      const search = url.searchParams.get('search') || undefined;
      const orders = await orderService.getAllOrders(status, search);
      sendJson(res, 200, { success: true, data: orders, correlationId }, correlationId);
      return;
    }

    // GET /api/v1/orders/:id
    if (pathname.startsWith('/api/v1/orders/') && method === 'GET') {
      const orderId = pathname.replace('/api/v1/orders/', '');
      const order = await orderService.getOrder(orderId);
      if (!order) {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Order not found' }, correlationId);
        return;
      }
      sendJson(res, 200, { success: true, data: order, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/orders/:id/cancel
    if (pathname.includes('/cancel') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('cancel') - 1];
      const body = await parseJsonBody(req);
      const cancelled = await orderService.cancelOrder(orderId, body.reason || 'User requested', body.actorId);
      sendJson(res, 200, { success: true, data: cancelled, correlationId }, correlationId);
      return;
    }

    // Admin Fulfillment Endpoints:
    // POST /api/v1/admin/orders/:id/process
    if (pathname.includes('/process') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('process') - 1];
      const updated = await orderService.startProcessing(orderId, 'admin');
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/orders/:id/ship
    if (pathname.includes('/ship') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('ship') - 1];
      const body = await parseJsonBody(req);
      const updated = await orderService.markAsShipped(orderId, body.courierName || 'Standard Courier', body.trackingNumber || 'TRK-001', 'admin');
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/orders/:id/deliver
    if (pathname.includes('/deliver') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('deliver') - 1];
      const updated = await orderService.markAsDelivered(orderId, 'admin');
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
};

export const orderServer = http.createServer(orderRequestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  orderServer.listen(PORT, () => {
    console.log(`[order-service] Running on port ${PORT}`);
  });
}
