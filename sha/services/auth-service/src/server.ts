/**
 * @file services/auth-service/src/server.ts
 * Auth Microservice HTTP Server
 */

import * as http from 'node:http';
import { InMemoryAuthRepository } from './repository.ts';
import { AuthService } from './service.ts';
import { verifyJwt } from './crypto.ts';

const PORT = Number(process.env.PORT) || 3001;
const repo = new InMemoryAuthRepository();
export const authService = new AuthService(repo);

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

function extractBearerToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7).trim();
}

export const requestListener: http.RequestListener = async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id, Idempotency-Key');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // Health & Ready
    if (pathname === '/health' || pathname === '/ready') {
      sendJson(res, 200, { status: 'UP', service: 'auth-service', timestamp: new Date().toISOString() }, correlationId);
      return;
    }

    // Register
    if (pathname === '/api/v1/auth/register' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.email || !body.password || !body.name || !body.phone) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'Name, email, phone, and password are required.' }, correlationId);
        return;
      }
      const session = await authService.register(body);
      sendJson(res, 201, { success: true, data: session, correlationId }, correlationId);
      return;
    }

    // Login
    if (pathname === '/api/v1/auth/login' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.email || !body.password) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'Email and password are required.' }, correlationId);
        return;
      }
      const session = await authService.login(body);
      sendJson(res, 200, { success: true, data: session, correlationId }, correlationId);
      return;
    }

    // Refresh
    if (pathname === '/api/v1/auth/refresh' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (!body.refreshToken) {
        sendJson(res, 400, { success: false, code: 'VALIDATION_ERROR', message: 'Refresh token is required.' }, correlationId);
        return;
      }
      const session = await authService.refresh(body.refreshToken);
      sendJson(res, 200, { success: true, data: session, correlationId }, correlationId);
      return;
    }

    // Logout
    if (pathname === '/api/v1/auth/logout' && method === 'POST') {
      const body = await parseJsonBody(req);
      if (body.refreshToken) {
        await authService.logout(body.refreshToken);
      }
      sendJson(res, 200, { success: true, data: { message: 'Logged out successfully' }, correlationId }, correlationId);
      return;
    }

    // Authenticated Endpoints
    const token = extractBearerToken(req);
    const jwtPayload = token ? verifyJwt(token) : null;

    if (pathname === '/api/v1/auth/me' && method === 'GET') {
      if (!jwtPayload) {
        sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', message: 'Invalid or missing authentication token.' }, correlationId);
        return;
      }
      const profile = await authService.getProfile(jwtPayload.sub);
      sendJson(res, 200, { success: true, data: profile, correlationId }, correlationId);
      return;
    }

    // Addresses
    if (pathname === '/api/v1/auth/addresses' && method === 'GET') {
      if (!jwtPayload) {
        sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', message: 'Unauthorized' }, correlationId);
        return;
      }
      const addresses = await authService.getAddresses(jwtPayload.sub);
      sendJson(res, 200, { success: true, data: addresses, correlationId }, correlationId);
      return;
    }

    if (pathname === '/api/v1/auth/addresses' && method === 'POST') {
      if (!jwtPayload) {
        sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', message: 'Unauthorized' }, correlationId);
        return;
      }
      const body = await parseJsonBody(req);
      const address = await authService.addAddress(jwtPayload.sub, body);
      sendJson(res, 201, { success: true, data: address, correlationId }, correlationId);
      return;
    }

    if (pathname.startsWith('/api/v1/auth/addresses/') && method === 'DELETE') {
      if (!jwtPayload) {
        sendJson(res, 401, { success: false, code: 'UNAUTHORIZED', message: 'Unauthorized' }, correlationId);
        return;
      }
      const addressId = pathname.replace('/api/v1/auth/addresses/', '');
      const deleted = await authService.deleteAddress(jwtPayload.sub, addressId);
      if (!deleted) {
        sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Address not found or unauthorized' }, correlationId);
        return;
      }
      sendJson(res, 200, { success: true, data: { deleted: true }, correlationId }, correlationId);
      return;
    }

    // Admin 2FA helper for development/testing
    if (pathname === '/api/v1/auth/admin/2fa-code' && method === 'GET') {
      const adminCode = authService.getAdminCurrentTotp('00000000-0000-0000-0000-000000000001');
      sendJson(res, 200, { success: true, data: { totpCode: adminCode }, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
};

export const server = http.createServer(requestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  server.listen(PORT, () => {
    console.log(`[auth-service] Running on port ${PORT}`);
  });
}
