/**
 * @file services/auth-service/tests/auth.test.ts
 * Comprehensive Unit & Integration Tests for Auth Service
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { InMemoryAuthRepository } from '../src/repository.ts';
import { AuthService } from '../src/service.ts';
import { verifyJwt } from '../src/crypto.ts';

describe('Auth Service & Security Baseline Tests', () => {
  const repo = new InMemoryAuthRepository();
  const service = new AuthService(repo);

  it('should register a new customer successfully with hashed password', async () => {
    const session = await service.register({
      name: 'Ravi Kumar',
      email: 'Ravi.Kumar@Example.com',
      phone: '+919812345678',
      password: 'SecurePassword123!',
    });

    assert.ok(session.accessToken, 'Access token should be issued');
    assert.ok(session.refreshToken, 'Refresh token should be issued');
    assert.strictEqual(session.user.email, 'ravi.kumar@example.com', 'Email should be normalized to lowercase');
    assert.strictEqual(session.user.role, 'CUSTOMER');

    // Verify raw password is not stored
    const stored = await repo.findUserByEmail('ravi.kumar@example.com');
    assert.ok(stored);
    assert.notStrictEqual(stored.password_hash, 'SecurePassword123!');
    assert.ok(stored.password_hash.includes(':'), 'Hash must contain salt and derived key');
  });

  it('should reject duplicate email registration', async () => {
    await assert.rejects(
      async () => {
        await service.register({
          name: 'Another Ravi',
          email: 'ravi.kumar@example.com',
          phone: '+919999999999',
          password: 'AnotherPassword123!',
        });
      },
      /already exists/i
    );
  });

  it('should verify customer login and return valid JWT with claims', async () => {
    const session = await service.login({
      email: 'ravi.kumar@example.com',
      password: 'SecurePassword123!',
    });

    assert.ok(session.accessToken);
    const decoded = verifyJwt(session.accessToken);
    assert.ok(decoded);
    assert.strictEqual(decoded.sub, session.user.id);
    assert.strictEqual(decoded.email, 'ravi.kumar@example.com');
    assert.strictEqual(decoded.role, 'CUSTOMER');
  });

  it('should enforce account lockout after 5 consecutive failed login attempts (OWASP A07)', async () => {
    // Attempt 1 to 4 should fail with generic message
    for (let i = 1; i <= 4; i++) {
      await assert.rejects(
        () => service.login({ email: 'ravi.kumar@example.com', password: 'WrongPassword!' }),
        /Email or password incorrect/i
      );
    }

    // 5th attempt triggers lockout
    await assert.rejects(
      () => service.login({ email: 'ravi.kumar@example.com', password: 'WrongPassword!' }),
      /locked for 15 minutes/i
    );

    // 6th attempt while locked should reject immediately
    await assert.rejects(
      () => service.login({ email: 'ravi.kumar@example.com', password: 'SecurePassword123!' }),
      /temporarily locked/i
    );
  });

  it('should require and verify TOTP 2FA for store administrator login', async () => {
    const adminEmail = 'admin@hira.in';
    const adminPass = 'HiraAdminSecure2026!';

    // Missing 2FA code should fail
    await assert.rejects(
      () => service.login({ email: adminEmail, password: adminPass }),
      /TOTP 2FA code is required/i
    );

    // Invalid 2FA code should fail
    await assert.rejects(
      () => service.login({ email: adminEmail, password: adminPass, totpCode: '000000' }),
      /Invalid 2FA code/i
    );

    // Valid 2FA code should succeed
    const validTotp = service.getAdminCurrentTotp('00000000-0000-0000-0000-000000000001');
    const adminSession = await service.login({
      email: adminEmail,
      password: adminPass,
      totpCode: validTotp,
    });

    assert.ok(adminSession.accessToken);
    assert.strictEqual(adminSession.user.role, 'ADMIN');
  });

  it('should rotate refresh tokens and revoke old refresh token (OWASP A07)', async () => {
    // Reset user lockout for test
    const user = await repo.findUserByEmail('ravi.kumar@example.com');
    if (user) await repo.updateUser(user.id, { locked_until: null, failed_attempts: 0 });

    const session = await service.login({
      email: 'ravi.kumar@example.com',
      password: 'SecurePassword123!',
    });

    const oldRefreshToken = session.refreshToken;
    const newSession = await service.refresh(oldRefreshToken);

    assert.ok(newSession.accessToken);
    assert.notStrictEqual(newSession.refreshToken, oldRefreshToken, 'Refresh token must be rotated');

    // Replay attack: Old refresh token must be rejected
    await assert.rejects(
      () => service.refresh(oldRefreshToken),
      /Invalid or revoked refresh token/i
    );
  });

  it('should manage addresses with strict ownership checks (IDOR protection OWASP A01)', async () => {
    const user = await repo.findUserByEmail('ravi.kumar@example.com');
    assert.ok(user);

    const addr = await service.addAddress(user.id, {
      name: 'Ravi Kumar',
      phone: '+919812345678',
      line1: '12 Temple Street',
      city: 'Madurai',
      state: 'Tamil Nadu',
      pincode: '625001',
      is_default: true,
    });

    assert.ok(addr.id);
    const addresses = await service.getAddresses(user.id);
    assert.strictEqual(addresses.length, 1);
    assert.strictEqual(addresses[0].city, 'Madurai');

    // Other user cannot delete Ravi's address
    const otherUserId = 'other-user-uuid';
    const deletedByOther = await service.deleteAddress(otherUserId, addr.id);
    assert.strictEqual(deletedByOther, false, 'Other user must not be able to delete address');

    // Owner can delete
    const deletedByOwner = await service.deleteAddress(user.id, addr.id);
    assert.strictEqual(deletedByOwner, true, 'Owner should be able to delete own address');
  });
});
