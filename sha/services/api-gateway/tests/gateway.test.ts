/**
 * @file services/api-gateway/tests/gateway.test.ts
 * API Gateway Security Headers, Rate Limiting & Routing Unit Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import {
  applySecurityHeaders,
  resolveTargetService,
  SERVICE_ROUTES,
} from '../src/server.ts';
import { RateLimiter } from '../src/rate-limiter.ts';

describe('API Gateway & Security Baseline Tests', () => {
  it('should apply all OWASP A05 mandatory security headers', () => {
    const headers: Record<string, string> = {};
    const mockRes = {
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
    } as unknown as http.ServerResponse;

    applySecurityHeaders(mockRes);

    assert.strictEqual(headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(headers['x-frame-options'], 'DENY');
    assert.strictEqual(headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.ok(headers['content-security-policy'].includes("default-src 'self'"));
    assert.ok(headers['access-control-allow-origin']);
  });

  it('should accurately resolve paths to respective microservices', () => {
    assert.strictEqual(resolveTargetService('/api/v1/auth/login'), SERVICE_ROUTES.auth);
    assert.strictEqual(resolveTargetService('/api/v1/products'), SERVICE_ROUTES.catalog);
    assert.strictEqual(resolveTargetService('/api/v1/categories'), SERVICE_ROUTES.catalog);
    assert.strictEqual(resolveTargetService('/api/v1/cart/items'), SERVICE_ROUTES.cart);
    assert.strictEqual(resolveTargetService('/api/v1/orders'), SERVICE_ROUTES.order);
    assert.strictEqual(resolveTargetService('/api/v1/payments/create'), SERVICE_ROUTES.payment);
    assert.strictEqual(resolveTargetService('/api/v1/webhooks/razorpay'), SERVICE_ROUTES.payment);
    assert.strictEqual(resolveTargetService('/api/v1/admin/products'), SERVICE_ROUTES.catalog);
    assert.strictEqual(resolveTargetService('/api/v1/admin/orders'), SERVICE_ROUTES.order);
    assert.strictEqual(resolveTargetService('/api/v1/unknown'), null);
  });

  it('should enforce sliding window rate limiting (OWASP A07 & A04)', () => {
    const limiter = new RateLimiter();
    const key = 'test-client-ip:api';

    // Allow 5 requests in a 1-second window
    for (let i = 1; i <= 5; i++) {
      const check = limiter.isAllowed(key, 5, 1000);
      assert.strictEqual(check.allowed, true, `Request ${i} should be allowed`);
    }

    // 6th request must be rejected
    const blockedCheck = limiter.isAllowed(key, 5, 1000);
    assert.strictEqual(blockedCheck.allowed, false, 'Request exceeding limit must be blocked');
    assert.strictEqual(blockedCheck.remaining, 0);
  });
});
