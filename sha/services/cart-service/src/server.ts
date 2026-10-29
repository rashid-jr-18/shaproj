/**
 * @file services/cart-service/src/server.ts
 * Cart Service HTTP Server
 */

import * as http from 'node:http';
import { InMemoryCartRepository } from './repository.ts';
import { CartService } from './service.ts';

const PORT = Number(process.env.PORT) || 3004;
export const cartRepo = new InMemoryCartRepository();
export const cartService = new CartService(cartRepo);

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

function getCartSessionId(req: http.IncomingMessage): string {
  return (req.headers['x-cart-id'] as string) || (req.headers['x-session-id'] as string) || 'guest-default-session';
}

export const cartRequestListener: http.RequestListener = async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr-${Date.now()}`;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();
  const cartId = getCartSessionId(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id, X-Cart-Id, X-Session-Id');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/health' || pathname === '/ready') {
      sendJson(res, 200, { status: 'UP', service: 'cart-service' }, correlationId);
      return;
    }

    // GET /api/v1/cart
    if (pathname === '/api/v1/cart' && method === 'GET') {
      const cart = await cartService.getOrCreateCart(cartId);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/cart/items
    if (pathname === '/api/v1/cart/items' && method === 'POST') {
      const body = await parseJsonBody(req);
      const cart = await cartService.addItem(cartId, body);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    // PATCH /api/v1/cart/items/:productId
    if (pathname.startsWith('/api/v1/cart/items/') && method === 'PATCH') {
      const productId = pathname.replace('/api/v1/cart/items/', '');
      const body = await parseJsonBody(req);
      const cart = await cartService.updateItemQty(cartId, productId, body.qty);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    // DELETE /api/v1/cart/items/:productId
    if (pathname.startsWith('/api/v1/cart/items/') && method === 'DELETE') {
      const productId = pathname.replace('/api/v1/cart/items/', '');
      const cart = await cartService.removeItem(cartId, productId);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/cart/merge (Guest to User)
    if (pathname === '/api/v1/cart/merge' && method === 'POST') {
      const body = await parseJsonBody(req);
      const merged = await cartService.mergeGuestCart(body.guestCartId, body.userCartId, body.userId);
      sendJson(res, 200, { success: true, data: merged, correlationId }, correlationId);
      return;
    }

    // DELETE /api/v1/cart
    if (pathname === '/api/v1/cart' && method === 'DELETE') {
      await cartService.clearCart(cartId);
      sendJson(res, 200, { success: true, data: { cleared: true }, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
};

export const cartServer = http.createServer(cartRequestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  cartServer.listen(PORT, () => {
    console.log(`[cart-service] Running on port ${PORT}`);
  });
}
