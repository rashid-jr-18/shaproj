/**
 * @file services/inventory-service/src/server.ts
 * Inventory Service HTTP Server
 */

import * as http from 'node:http';
import { InMemoryInventoryRepository } from './repository.ts';
import { InventoryService } from './service.ts';

const PORT = Number(process.env.PORT) || 3003;
export const inventoryRepo = new InMemoryInventoryRepository();
export const inventoryService = new InventoryService(inventoryRepo);

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
      if (body.length > 1e6) {
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

export const inventoryRequestListener: http.RequestListener = async (req, res) => {
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
      sendJson(res, 200, { status: 'UP', service: 'inventory-service' }, correlationId);
      return;
    }

    // GET /api/v1/inventory/:productId
    if (pathname.startsWith('/api/v1/inventory/') && method === 'GET') {
      const productId = pathname.replace('/api/v1/inventory/', '');
      const inv = await inventoryService.getProductInventory(productId);
      if (!inv) {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Product not found in inventory' }, correlationId);
        return;
      }
      sendJson(res, 200, { success: true, data: inv, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/inventory/reserve (Internal sync call from order-service)
    if (pathname === '/api/v1/inventory/reserve' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.orderRef || !Array.isArray(body.items)) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'orderRef and items array required' }, correlationId);
        return;
      }
      const result = await inventoryService.reserveCart(body.orderRef, body.items);
      if (!result.success) {
        sendJson(res, 409, {
          success: false,
          code: 'OUT_OF_STOCK',
          message: `Product ${result.failedProductId} is out of stock or insufficient quantity available.`,
          details: { failedProductId: result.failedProductId },
        }, correlationId);
        return;
      }
      sendJson(res, 200, { success: true, data: { reserved: true, orderRef: body.orderRef }, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/inventory/finalize
    if (pathname === '/api/v1/inventory/finalize' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.orderRef) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'orderRef is required' }, correlationId);
        return;
      }
      const finalized = await inventoryService.finalizeReservation(body.orderRef);
      sendJson(res, 200, { success: true, data: { finalized }, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/inventory/release
    if (pathname === '/api/v1/inventory/release' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.orderRef) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'orderRef is required' }, correlationId);
        return;
      }
      const released = await inventoryService.releaseReservation(body.orderRef, body.reason);
      sendJson(res, 200, { success: true, data: { released }, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/inventory/:id/restock
    if (pathname.includes('/restock') && method === 'POST') {
      const parts = pathname.split('/');
      const productId = parts[parts.indexOf('restock') - 1];
      const body = await parseJsonBody(req);
      const inv = await inventoryService.restock(productId, Number(body.qty), body.note || '', body.actorId);
      sendJson(res, 200, { success: true, data: inv, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/inventory/:id/adjust
    if (pathname.includes('/adjust') && method === 'POST') {
      const parts = pathname.split('/');
      const productId = parts[parts.indexOf('adjust') - 1];
      const body = await parseJsonBody(req);
      const inv = await inventoryService.adjustStock(productId, Number(body.newOnHand), body.reason || '', body.actorId);
      sendJson(res, 200, { success: true, data: inv, correlationId }, correlationId);
      return;
    }

    // GET /api/v1/admin/inventory/movements
    if (pathname === '/api/v1/admin/inventory/movements' && method === 'GET') {
      const productId = url.searchParams.get('productId') || undefined;
      const movements = await inventoryService.getMovements(productId);
      sendJson(res, 200, { success: true, data: movements, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
};

export const inventoryServer = http.createServer(inventoryRequestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  inventoryServer.listen(PORT, () => {
    console.log(`[inventory-service] Running on port ${PORT}`);
  });
}
