/**
 * @file services/api-gateway/src/server.ts
 * Hira API Gateway - Single Public Entrypoint with Rate Limiting, RBAC & Security Headers
 */

import * as http from 'node:http';
import { RateLimiter } from './rate-limiter.ts';

const PORT = Number(process.env.PORT) || 8000;

export const SERVICE_ROUTES = {
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  catalog: process.env.CATALOG_SERVICE_URL || 'http://localhost:3002',
  inventory: process.env.INVENTORY_SERVICE_URL || 'http://localhost:3003',
  cart: process.env.CART_SERVICE_URL || 'http://localhost:3004',
  order: process.env.ORDER_SERVICE_URL || 'http://localhost:3005',
  payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:3006',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3007',
};

export const rateLimiter = new RateLimiter();

// Security Headers (Section 8 OWASP A05)
export function applySecurityHeaders(res: http.ServerResponse) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://www.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https: fonts.gstatic.com; connect-src 'self' https:; frame-src 'self' https://*.firebaseapp.com https://www.google.com https://recaptcha.google.com;"
  );
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Correlation-Id, Idempotency-Key, X-Cart-Id, X-Session-Id'
  );
}

export function resolveTargetService(pathname: string): string | null {
  if (pathname.startsWith('/api/v1/auth')) return SERVICE_ROUTES.auth;
  if (pathname.startsWith('/api/v1/products') || pathname.startsWith('/api/v1/categories')) return SERVICE_ROUTES.catalog;
  if (pathname.startsWith('/api/v1/inventory')) return SERVICE_ROUTES.inventory;
  if (pathname.startsWith('/api/v1/cart')) return SERVICE_ROUTES.cart;
  if (pathname.startsWith('/api/v1/orders')) return SERVICE_ROUTES.order;
  if (pathname.startsWith('/api/v1/payments') || pathname.startsWith('/api/v1/webhooks')) return SERVICE_ROUTES.payment;
  
  // Admin namespaces
  if (pathname.startsWith('/api/v1/admin/products')) return SERVICE_ROUTES.catalog;
  if (pathname.startsWith('/api/v1/admin/inventory')) return SERVICE_ROUTES.inventory;
  if (pathname.startsWith('/api/v1/admin/orders')) return SERVICE_ROUTES.order;
  if (pathname.startsWith('/api/v1/admin/payments')) return SERVICE_ROUTES.payment;

  return null;
}

export const gatewayRequestListener: http.RequestListener = async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `hira-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
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
  const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';

  // 1. Health check
  if (pathname === '/health' || pathname === '/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'UP', service: 'api-gateway', timestamp: new Date().toISOString() }));
    return;
  }

  // 2. Rate Limiting (OWASP A07 & A04)
  const isAuthRoute = pathname.startsWith('/api/v1/auth');
  const maxReqs = isAuthRoute ? 20 : 100; // tighter limit for auth
  const rateLimitCheck = rateLimiter.isAllowed(`${clientIp}:${isAuthRoute ? 'auth' : 'api'}`, maxReqs, 60000);

  if (!rateLimitCheck.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please slow down and try again shortly.',
        correlationId,
      })
    );
    return;
  }

  // 3. Admin Authorization Enforcement (OWASP A01: Broken Access Control)
  if (pathname.startsWith('/api/v1/admin/')) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          code: 'UNAUTHORIZED',
          message: 'Admin authorization token required.',
          correlationId,
        })
      );
      return;
    }
  }

  // 4. Resolve Target Microservice
  const targetHost = resolveTargetService(pathname);
  if (!targetHost) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        code: 'NOT_FOUND',
        message: 'Route not found on Hira API Gateway.',
        correlationId,
      })
    );
    return;
  }

  // 5. Proxy Forwarding
  const targetUrl = new URL(req.url || '/', targetHost);
  const proxyReq = http.request(
    targetUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        'x-correlation-id': correlationId,
        host: targetUrl.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        code: 'SERVICE_UNAVAILABLE',
        message: `Upstream service temporarily unavailable: ${err.message}`,
        correlationId,
      })
    );
  });

  req.pipe(proxyReq);
};

export const gatewayServer = http.createServer(gatewayRequestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  gatewayServer.listen(PORT, () => {
    console.log(`[api-gateway] Running on port ${PORT}`);
  });
}
