/**
 * @file services/payment-service/src/server.ts
 * Payment Service HTTP Server
 */

import * as http from 'node:http';
import { InMemoryPaymentRepository } from './repository.ts';
import { PaymentService } from './service.ts';

const PORT = Number(process.env.PORT) || 3006;
export const paymentRepo = new InMemoryPaymentRepository();
export const paymentService = new PaymentService(paymentRepo);

function sendJson(res: http.ServerResponse, statusCode: number, data: any, correlationId: string) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'X-Correlation-Id': correlationId,
  });
  res.end(JSON.stringify(data));
}

function parseRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export const paymentRequestListener: http.RequestListener = async (req, res) => {
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr-${Date.now()}`;
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-Id, X-Razorpay-Signature');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/health' || pathname === '/ready') {
      sendJson(res, 200, { status: 'UP', service: 'payment-service' }, correlationId);
      return;
    }

    // POST /api/v1/payments/create
    if (pathname === '/api/v1/payments/create' && method === 'POST') {
      const raw = await parseRawBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const payment = await paymentService.createPaymentIntent(body.orderId, body.amount, body.method || 'RAZORPAY');
      sendJson(res, 201, { success: true, data: payment, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/webhooks/razorpay (Server-to-Server Signed Webhook)
    if (pathname === '/api/v1/webhooks/razorpay' && method === 'POST') {
      const signature = (req.headers['x-razorpay-signature'] as string) || '';
      const rawBody = await parseRawBody(req);
      const payload = rawBody ? JSON.parse(rawBody) : {};

      const result = await paymentService.handleRazorpayWebhook(rawBody, signature, payload);
      sendJson(res, 200, { success: true, data: result, correlationId }, correlationId);
      return;
    }

    // POST /api/v1/admin/payments/:id/refund
    if (pathname.includes('/refund') && method === 'POST') {
      const parts = pathname.split('/');
      const paymentId = parts[parts.indexOf('refund') - 1];
      const raw = await parseRawBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const refund = await paymentService.processRefund(paymentId, body.amount, body.reason || 'Admin refund');
      sendJson(res, 200, { success: true, data: refund, correlationId }, correlationId);
      return;
    }

    sendJson(res, 404, { success: false, code: 'NOT_FOUND', message: 'Endpoint not found' }, correlationId);
  } catch (err: any) {
    sendJson(res, 400, { success: false, code: 'BAD_REQUEST', message: err.message }, correlationId);
  }
};

export const paymentServer = http.createServer(paymentRequestListener);

const isTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);

if (!isTest && !process.env.IMPORT_ONLY) {
  paymentServer.listen(PORT, () => {
    console.log(`[payment-service] Running on port ${PORT}`);
  });
}
