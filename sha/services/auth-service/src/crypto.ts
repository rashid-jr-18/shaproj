/**
 * @file services/auth-service/src/crypto.ts
 * Cryptographic operations: Scrypt password hashing, JWT HMAC-SHA256, and RFC 6238 TOTP
 */

import * as crypto from 'node:crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'hira_super_secret_jwt_signing_key_2026';
const SCRYPT_KEYLEN = 64;

// --- 1. Password Hashing (Scrypt + Salt + Timing Safe) ---
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${derivedKey.toString('hex')}`;
}

export function verifyPassword(password: string, combinedHash: string): boolean {
  try {
    const [salt, key] = combinedHash.split(':');
    if (!salt || !key) return false;
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

// --- 2. Refresh Token Hashing (SHA-256) ---
export function generateRandomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// --- 3. Lightweight JWT (HMAC-SHA256) ---
export interface JwtPayload {
  sub: string; // User ID
  email: string;
  role: 'CUSTOMER' | 'ADMIN';
  iat?: number;
  exp?: number;
  [key: string]: any;
}

export function signJwt(payload: JwtPayload, expiresInSeconds: number = 900): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedPayload, signature] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return null; // Token expired
    }

    return payload;
  } catch {
    return null;
  }
}

// --- 4. Admin 2FA (TOTP RFC 6238) ---
export function generateTotpSecret(): string {
  return crypto.randomBytes(20).toString('hex');
}

export function generateTotpCode(secretHex: string, timeStepWindow: number = 0): string {
  const epoch = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30) + timeStepWindow;
  
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(BigInt(timeStep));

  const secretBuffer = Buffer.from(secretHex, 'hex');
  const hmac = crypto.createHmac('sha1', secretBuffer).update(buffer).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const code = (codeInt % 1000000).toString().padStart(6, '0');
  return code;
}

export function verifyTotpCode(secretHex: string, userCode: string): boolean {
  // Check current window and +/- 1 window for slight clock skew
  for (const window of [-1, 0, 1]) {
    const expected = generateTotpCode(secretHex, window);
    if (expected === userCode.trim()) {
      return true;
    }
  }
  return false;
}

