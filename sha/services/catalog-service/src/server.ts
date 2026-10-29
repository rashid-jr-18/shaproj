/**
 * @file services/catalog-service/src/server.ts
 * Catalog Service HTTP Server with Auto-Seeding of 50 Initial Products
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InMemoryCatalogRepository } from './repository.ts';
import { CatalogService } from './service.ts';

const PORT = Number(process.env.PORT) || 3002;
export const catalogRepo = new InMemoryCatalogRepository();
export const catalogService = new CatalogService(catalogRepo);

// Auto-seed initial 50 products
async function autoSeedCatalog() {
  try {
    const csvPath = path.resolve(process.cwd(), 'infra/seeds/products.csv');
    if (fs.existsSync(csvPath)) {
      const content = fs.readFileSync(csvPath, 'utf8');
      const res = await catalogService.importProductsFromCsv(content);
      console.log(`[catalog-service] Auto-seeded ${res.importedCount} products into catalog.`);
    }
  } catch (err: any) {
    console.error('[catalog-service] Error seeding catalog:', err.message);
  }
}

autoSeedCatalog();

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

export const catalogRequestListener: http.RequestListener = async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr-${Date.now()}`;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id, Idempotency-Key');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/health' || pathname === '/ready') {
      sendJson(res, 200, { status: 'UP', service: 'catalog-service' }, correlationId);
      return;
    }

    // GET /api/v1/categories
    if (pathname === '/api/v1/categories' && method === 'GET') {
      const categories = await catalogService.getCategories();
      sendJson(res, 200, { success: true, data: categories, correlationId }, correlationId);
      return;
    }

    // GET /api/v1/products (Listing)
    if (pathname === '/api/v1/products' && method === 'GET') {
      const search = url.searchParams.get('search') || undefined;
      const categorySlug = url.searchParams.get('category') || undefined;
      const sort = (url.searchParams.get('sort') as any) || undefined;
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);

      const result = await catalogService.getProducts({
        search,
        categorySlug,
        sort,
        page,
        limit,
      });

      sendJson(res, 200, {
        success: true,
        data: result.products,
        meta: {
          page,
          limit,
          total: result.total,
          hasMore: page * limit < result.total,
        },
        correlationId,
      }, correlationId);
      return;
    }

    // GET /api/v1/products/:slug (Detail)
    if (pathname.startsWith('/api/v1/products/') && method === 'GET') {
      const slug = pathname.replace('/api/v1/products/', '');
      const product = await catalogService.getProductBySlug(slug);
      if (!product) {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Product not found' }, correlationId);
        return;
      }
      sendJson(res, 200, { success: true, data: product, correlationId }, correlationId);
      return;
    }

    // Admin Endpoints
    // POST /api/v1/admin/products
    if (pathname === '/api/v1/admin/products' && method === 'POST') {
      const body = await parseJsonBody(req);
      const product = await catalogService.createProduct(body);
      sendJson(res, 201, { success: true, data: product, correlationId }, correlationId);
      return;
    }

    // PATCH /api/v1/admin/products/:id/availability
    if (pathname.includes('/availability') && method === 'PATCH') {
      const parts = pathname.split('/');
      const id = parts[parts.indexOf('availability') - 1];
      const body = await parseJsonBody(req);
      const updated = await catalogService.setAvailability(id, body.status);
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/products/:id/price
    if (pathname.includes('/price') && method === 'POST') {
      const parts = pathname.split('/');
      const id = parts[parts.indexOf('price') - 1];
      const body = await parseJsonBody(req);
      const updated = await catalogService.updatePrice(id, body.price);
      sendJson(res, 200, { success: true, data: updated, correlationId }, correlationId);
      return;
    }

    // DELETE /api/v1/admin/products/:id (Archive)
    if (pathname.startsWith('/api/v1/admin/products/') && method === 'DELETE') {
      const id = pathname.replace('/api/v1/admin/products/', '');
      const archived = await catalogService.archiveProduct(id);
      sendJson(res, 200, { success: true, data: { archived }, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/products/import-csv
    if (pathname === '/api/v1/admin/products/import-csv' && method === 'POST') {
      const body = await parseJsonBody(req);
      const result = await catalogService.importProductsFromCsv(body.csvContent);
      sendJson(res, 200, { success: true, data: result, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
};

export const catalogServer = http.createServer(catalogRequestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  catalogServer.listen(PORT, () => {
    console.log(`[catalog-service] Running on port ${PORT}`);
  });
}
