/**
 * @file server.ts
 * Hira Monorepo Unified Development & Demo Server
 * Mounts API Gateway, Microservices & Static Web/Admin Frontends
 */

process.env.IMPORT_ONLY = 'true';

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Microservices Singletons
import { authService, requestListener as authHandler } from './services/auth-service/src/server.ts';
import { catalogService, catalogRepo } from './services/catalog-service/src/server.ts';
import { inventoryService, inventoryRepo } from './services/inventory-service/src/server.ts';
import { cartService, cartRepo } from './services/cart-service/src/server.ts';
import { orderService, orderRepo } from './services/order-service/src/server.ts';
import { paymentService, paymentRepo } from './services/payment-service/src/server.ts';
import { rateLimiter, applySecurityHeaders } from './services/api-gateway/src/server.ts';

const PORT = Number(process.env.PORT) || 8000;

// Connect Order Service with live Catalog and Inventory services
export const liveOrderService = new (orderService.constructor as any)(orderRepo, {
  catalogLookup: async (productId: string) => {
    const p = await catalogRepo.getProductById(productId);
    if (!p) return null;
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      price: p.price,
      tax_rate: p.tax_rate,
      status: p.status,
    };
  },
  inventoryReserve: async (orderRef: string, items: Array<{ productId: string; qty: number }>) => {
    return inventoryService.reserveCart(orderRef, items);
  },
  inventoryFinalize: async (orderRef: string) => {
    return inventoryService.finalizeReservation(orderRef);
  },
  inventoryRelease: async (orderRef: string, reason?: string) => {
    return inventoryService.releaseReservation(orderRef, reason);
  },
});

// Auto-seed initial 50 products and initial stock into inventory
async function initializeStore() {
  const csvPath = path.resolve(process.cwd(), 'infra/seeds/products.csv');
  if (fs.existsSync(csvPath)) {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',').map((p) => p.trim());
      if (parts.length >= 10) {
        const [sku, name, slug, category, priceStr, mrpStr, taxStr, desc, stockStr, threshStr, imageUrl] = parts;
        try {
          const product = await catalogService.createProduct({
            sku,
            name,
            slug,
            categoryName: category,
            price: parseInt(priceStr, 10),
            mrp: parseInt(mrpStr, 10),
            tax_rate: parseInt(taxStr, 10),
            description: desc,
            imageUrl: imageUrl || undefined,
          });

          await inventoryService.initializeStock(
            product.id,
            parseInt(stockStr, 10) || 10,
            parseInt(threshStr, 10) || 3
          );
        } catch {
          // Ignore duplicates
        }
      }
    }
    console.log('[Hira Boot] Initialized 50 products and inventory successfully.');
  }
}

initializeStore();

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
      if (body.length > 5e6) {
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

function serveStaticFile(res: http.ServerResponse, filePath: string, contentType: string) {
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
  }
}

export const server = http.createServer(async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `hira-${Date.now()}`;
  applySecurityHeaders(res);
  res.setHeader('X-Correlation-Id', correlationId);

  const method = req.method?.toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. Static Frontends
  if (pathname === '/' || pathname === '/index.html') {
    return serveStaticFile(res, path.resolve(process.cwd(), 'apps/web/public/index.html'), 'text/html');
  }
  if (pathname === '/app.js') {
    return serveStaticFile(res, path.resolve(process.cwd(), 'apps/web/public/app.js'), 'application/javascript');
  }
  if (pathname === '/styles.css') {
    return serveStaticFile(res, path.resolve(process.cwd(), 'apps/web/public/styles.css'), 'text/css');
  }

  // Owner / Admin Portal Frontend (Private /owner route)
  if (
    pathname === '/owner' ||
    pathname === '/owner/' ||
    pathname === '/owner/index.html' ||
    pathname === '/admin' ||
    pathname === '/admin/' ||
    pathname === '/admin/index.html'
  ) {
    return serveStaticFile(res, path.resolve(process.cwd(), 'apps/admin/public/index.html'), 'text/html');
  }
  if (pathname === '/owner.js' || pathname === '/admin.js') {
    return serveStaticFile(res, path.resolve(process.cwd(), 'apps/admin/public/admin.js'), 'application/javascript');
  }

  // 2. Health & Status
  if (pathname === '/health' || pathname === '/ready') {
    sendJson(res, 200, { status: 'UP', name: 'Hira E-commerce Platform', version: '1.0.0' }, correlationId);
    return;
  }

  try {
    // 3. Auth Routes
    if (pathname.startsWith('/api/v1/auth')) {
      return authHandler(req, res);
    }

    // 4. Catalog Routes (with live stock projection from inventoryService)
    if (pathname === '/api/v1/categories' && method === 'GET') {
      const categories = await catalogService.getCategories();
      sendJson(res, 200, { success: true, data: categories, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/products' && method === 'GET') {
      const search = url.searchParams.get('search') || undefined;
      const categorySlug = url.searchParams.get('category') || undefined;
      const sort = (url.searchParams.get('sort') as any) || undefined;
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);

      const invMap = await inventoryService.getAllInventory();
      const result = await catalogService.getProducts(
        { search, categorySlug, sort, page, limit },
        invMap
      );

      sendJson(res, 200, {
        success: true,
        data: result.products,
        meta: { page, limit, total: result.total, hasMore: page * limit < result.total },
        correlationId,
      }, correlationId);
      return;
    }

    if (pathname.startsWith('/api/v1/products/') && method === 'GET') {
      const slug = pathname.replace('/api/v1/products/', '');
      const product = await catalogRepo.getProductBySlug(slug);
      if (!product) {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Product not found' }, correlationId);
        return;
      }
      const inv = await inventoryService.getProductInventory(product.id);
      const detail = await catalogService.getProductBySlug(slug, inv || undefined);
      sendJson(res, 200, { success: true, data: detail, correlationId }, correlationId);
      return;
    }

    // 5. Cart Routes
    const cartId = (req.headers['x-cart-id'] as string) || 'guest-cart';
    if (pathname === '/api/v1/cart' && method === 'GET') {
      const cart = await cartService.getOrCreateCart(cartId);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/cart/items' && method === 'POST') {
      const body = await parseJsonBody(req);
      const cart = await cartService.addItem(cartId, body);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    if (pathname.startsWith('/api/v1/cart/items/') && method === 'PATCH') {
      const productId = pathname.replace('/api/v1/cart/items/', '');
      const body = await parseJsonBody(req);
      const cart = await cartService.updateItemQty(cartId, productId, body.qty);
      sendJson(res, 200, { success: true, data: cart, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/cart/merge' && method === 'POST') {
      const body = await parseJsonBody(req);
      const merged = await cartService.mergeGuestCart(body.guestCartId, body.userCartId, body.userId);
      sendJson(res, 200, { success: true, data: merged, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/cart' && method === 'DELETE') {
      await cartService.clearCart(cartId);
      sendJson(res, 200, { success: true, data: { cleared: true }, correlationId }, correlationId);
      return;
    }

    // 6. Order Routes (Checkout Saga)
    if (pathname === '/api/v1/orders' && method === 'POST') {
      const idempotencyKey = (req.headers['idempotency-key'] as string) || '';
      const body = await parseJsonBody(req);
      const order = await liveOrderService.placeOrder({
        ...body,
        idempotencyKey,
      });
      sendJson(res, 201, { success: true, data: order, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/orders' && method === 'GET') {
      const userId = (req.headers['x-user-id'] as string) || url.searchParams.get('userId') || 'guest-user';
      const orders = await liveOrderService.getUserOrders(userId);
      sendJson(res, 200, { success: true, data: orders, correlationId }, correlationId);
      return;
    }

    // 7. Admin Endpoints
    if (pathname === '/api/v1/admin/orders' && method === 'GET') {
      const status = (url.searchParams.get('status') as any) || undefined;
      const orders = await liveOrderService.getAllOrders(status);
      sendJson(res, 200, { success: true, data: orders, correlationId }, correlationId);
      return;
    }

    if (pathname.includes('/process') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('process') - 1];
      const updated = await liveOrderService.startProcessing(orderId, 'admin');
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    if (pathname.includes('/ship') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('ship') - 1];
      const body = await parseJsonBody(req);
      const updated = await liveOrderService.markAsShipped(
        orderId,
        body.courierName || 'Delhivery',
        body.trackingNumber || 'TRK-9921',
        'admin'
      );
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    if (pathname.includes('/deliver') && method === 'POST') {
      const parts = pathname.split('/');
      const orderId = parts[parts.indexOf('deliver') - 1];
      const updated = await liveOrderService.markAsDelivered(orderId, 'admin');
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/products (Add New Product with Full Inventory Integration)
    if (pathname === '/api/v1/admin/products' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.name || !body.price) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'Product name and price are required.' }, correlationId);
        return;
      }

      const product = await catalogService.createProduct({
        sku: body.sku || `HRA-${Date.now().toString(36).toUpperCase()}`,
        name: body.name.trim(),
        slug: body.slug,
        description: body.description || '',
        categoryName: body.categoryName || 'Curated',
        price: Math.round(Number(body.price)), // paise
        mrp: Math.round(Number(body.mrp) || Number(body.price)),
        tax_rate: Number(body.tax_rate) || 5,
        imageUrl: body.imageUrl || 'https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=600&q=80',
        initialStock: Number(body.initialStock) || 10,
        lowStockThreshold: Number(body.lowStockThreshold) || 3,
      });

      await inventoryService.initializeStock(
        product.id,
        Number(body.initialStock) || 10,
        Number(body.lowStockThreshold) || 3
      );

      sendJson(res, 201, { success: true, data: product, correlationId }, correlationId);
      return;
    }

    if (pathname.includes('/availability') && method === 'PATCH') {
      const parts = pathname.split('/');
      const productId = parts[parts.indexOf('availability') - 1];
      const body = await parseJsonBody(req);
      const updated = await catalogService.setAvailability(productId, body.status);
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    if (pathname.includes('/restock') && method === 'POST') {
      const parts = pathname.split('/');
      const productId = parts[parts.indexOf('restock') - 1];
      const body = await parseJsonBody(req);
      const inv = await inventoryService.restock(productId, Number(body.qty), body.note || '', body.actorId);
      sendJson(res, 200, { success: true, data: inv, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/admin/inventory/movements' && method === 'GET') {
      const movements = await inventoryService.getMovements();
      sendJson(res, 200, { success: true, data: movements, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
});

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest) {
  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🌟 HIRA E-COMMERCE PLATFORM RUNNING ON PORT ${PORT}`);
    console.log(`🛍️ Customer Web App: http://localhost:${PORT}`);
    console.log(`👑 Store Owner Admin: http://localhost:${PORT}/admin`);
    console.log(`🔌 API Gateway Base:  http://localhost:${PORT}/api/v1`);
    console.log(`=======================================================`);
  });
}
