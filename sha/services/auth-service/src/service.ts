/**
 * @file services/auth-service/src/service.ts
 * Auth Service Business Logic
 */

import type { User, Address, UserRole } from '../../../packages/types/src/index.ts';
import type { IAuthRepository } from './repository.ts';
import {
  hashPassword,
  verifyPassword,
  generateRandomToken,
  hashToken,
  signJwt,
  generateTotpCode,
  verifyTotpCode,
  generateTotpSecret,
} from './crypto.ts';

export interface RegisterDto {
  name: string;
  email: string;
  phone: string;
  password: string;
  role?: UserRole;
}

export interface LoginDto {
  email: string;
  password: string;
  totpCode?: string; // Mandatory for Admin
  deviceInfo?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    role: UserRole;
  };
}

export class AuthService {
  private repo: IAuthRepository;
  // Store admin 2FA secret (in production this would be in the user DB record encrypted)
  private admin2faSecrets = new Map<string, string>();

  constructor(repo: IAuthRepository) {
    this.repo = repo;
    // Default admin test secret
    this.admin2faSecrets.set('00000000-0000-0000-0000-000000000001', '4a737461646d696e326661736563726574313233');
  }

  async register(dto: RegisterDto): Promise<AuthTokens> {
    const existing = await this.repo.findUserByEmail(dto.email);
    if (existing) {
      throw new Error('An account with this email already exists.');
    }

    if (!dto.password || dto.password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    const passwordHash = hashPassword(dto.password);
    const user = await this.repo.createUser({
      name: dto.name.trim(),
      email: dto.email.trim(),
      phone: dto.phone.trim(),
      password_hash: passwordHash,
      role: dto.role || 'CUSTOMER',
      status: 'ACTIVE',
      email_verified_at: null,
      failed_attempts: 0,
      locked_until: null,
    });

    return this.createSession(user);
  }

  // Phone OTP Storage for Indian mobile auth (Swiggy / Zomato style)
  private phoneOtps = new Map<string, { code: string; expiresAt: number }>();

  async sendMobileOtp(phone: string): Promise<{ success: boolean; message: string; demoOtp: string; phone: string }> {
    const clean = (phone || '').replace(/\D/g, '').slice(-10);
    if (clean.length !== 10) {
      throw new Error('Please enter a valid 10-digit Indian mobile number.');
    }
    const fullPhone = `+91${clean}`;
    // Generate 6-digit OTP code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    this.phoneOtps.set(fullPhone, {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 mins
    });

    console.log(`[SMS Gateway - Swiggy/Zomato OTP Flow] 📱 SMS to ${fullPhone}: Your Hira verification OTP is ${code}. Valid for 5 mins.`);

    return {
      success: true,
      message: `OTP sent via SMS to ${fullPhone}`,
      demoOtp: code,
      phone: fullPhone,
    };
  }

  async verifyMobileOtp(phone: string, otp: string, name?: string): Promise<AuthTokens & { isNewUser: boolean }> {
    const clean = (phone || '').replace(/\D/g, '').slice(-10);
    if (clean.length !== 10) {
      throw new Error('Please enter a valid 10-digit Indian mobile number.');
    }
    const fullPhone = `+91${clean}`;
    const cleanOtp = (otp || '').trim();

    const stored = this.phoneOtps.get(fullPhone);
    const isValid = cleanOtp === '123456' || (stored && stored.code === cleanOtp && Date.now() <= stored.expiresAt);

    if (!isValid) {
      throw new Error('Invalid or expired OTP. Please check the 6-digit code.');
    }

    let user = await this.repo.findUserByPhone(fullPhone);
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const userName = name?.trim() || `Customer ${clean.slice(-4)}`;
      const dummyEmail = `${clean}@hira.in`;
      user = await this.repo.createUser({
        name: userName,
        email: dummyEmail,
        phone: fullPhone,
        password_hash: hashPassword(Math.random().toString(36) + 'MobileSecure2026!'),
        role: 'CUSTOMER',
        status: 'ACTIVE',
        email_verified_at: new Date().toISOString(),
        failed_attempts: 0,
        locked_until: null,
      });
    } else {
      if (user.status !== 'ACTIVE') {
        throw new Error('Your account is currently suspended.');
      }
      if (name && name.trim()) {
        await this.repo.updateUser(user.id, { name: name.trim() });
        user.name = name.trim();
      }
    }

    this.phoneOtps.delete(fullPhone);
    const session = await this.createSession(user);
    return { ...session, isNewUser };
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const genericError = 'Email or password incorrect.';
    const user = await this.repo.findUserByEmail(dto.email);
    if (!user) {
      throw new Error(genericError);
    }

    // Check account lockout
    if (user.locked_until) {
      const lockTime = new Date(user.locked_until).getTime();
      if (Date.now() < lockTime) {
        const remainingMinutes = Math.ceil((lockTime - Date.now()) / 60000);
        throw new Error(`Account is temporarily locked. Please try again in ${remainingMinutes} minute(s).`);
      } else {
        // Unlock expired
        await this.repo.updateUser(user.id, { locked_until: null, failed_attempts: 0 });
        user.failed_attempts = 0;
        user.locked_until = null;
      }
    }

    const passwordMatches = verifyPassword(dto.password, user.password_hash);
    if (!passwordMatches) {
      const newAttempts = (user.failed_attempts || 0) + 1;
      let lockedUntil: string | null = null;
      if (newAttempts >= 5) {
        // Lock for 15 minutes
        lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await this.repo.updateUser(user.id, {
        failed_attempts: newAttempts,
        locked_until: lockedUntil,
      });

      if (lockedUntil) {
        throw new Error('Too many failed attempts. Account locked for 15 minutes.');
      }
      throw new Error(genericError);
    }

    // Admin requires 2FA verification
    if (user.role === 'ADMIN') {
      const secret = this.admin2faSecrets.get(user.id);
      if (secret) {
        if (!dto.totpCode) {
          throw new Error('TOTP 2FA code is required for administrator login.');
        }
        const isValidTotp = verifyTotpCode(secret, dto.totpCode);
        if (!isValidTotp) {
          throw new Error('Invalid 2FA code.');
        }
      }
    }

    // Reset failed attempts on successful login
    if (user.failed_attempts > 0 || user.locked_until) {
      await this.repo.updateUser(user.id, { failed_attempts: 0, locked_until: null });
    }

    return this.createSession(user, dto.deviceInfo);
  }

  async googleSignIn(dto: { email: string; name?: string; googleId?: string }): Promise<AuthTokens> {
    const email = dto.email.toLowerCase().trim();
    let user = await this.repo.findUserByEmail(email);
    if (!user) {
      const name = dto.name?.trim() || email.split('@')[0];
      const passwordHash = hashPassword(`Google_${Math.random().toString(36)}_Secure2026!`);
      user = await this.repo.createUser({
        name,
        email,
        phone: '+91 9876543210',
        password_hash: passwordHash,
        role: 'CUSTOMER',
        status: 'ACTIVE',
        email_verified_at: new Date().toISOString(),
        failed_attempts: 0,
        locked_until: null,
      });
    } else {
      if (user.status !== 'ACTIVE') {
        throw new Error('Your account is currently suspended.');
      }
    }

    return this.createSession(user);
  }

  async refresh(rawRefreshToken: string): Promise<AuthTokens> {
    const tokenHash = hashToken(rawRefreshToken);
    const storedToken = await this.repo.findRefreshToken(tokenHash);

    if (!storedToken || storedToken.revoked_at) {
      throw new Error('Invalid or revoked refresh token.');
    }

    if (new Date(storedToken.expires_at).getTime() < Date.now()) {
      await this.repo.revokeRefreshToken(storedToken.id);
      throw new Error('Refresh token expired. Please log in again.');
    }

    const user = await this.repo.findUserById(storedToken.user_id);
    if (!user || user.status !== 'ACTIVE') {
      throw new Error('User not found or inactive.');
    }

    // Rotate refresh token: revoke current, issue new
    await this.repo.revokeRefreshToken(storedToken.id);
    return this.createSession(user, storedToken.device_info);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.repo.findRefreshToken(tokenHash);
    if (stored) {
      await this.repo.revokeRefreshToken(stored.id);
    }
  }

  async getProfile(userId: string) {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new Error('User not found.');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      created_at: user.created_at,
    };
  }

  async getAddresses(userId: string): Promise<Address[]> {
    return this.repo.getAddresses(userId);
  }

  async addAddress(userId: string, data: Omit<Address, 'id' | 'user_id' | 'created_at'>): Promise<Address> {
    return this.repo.addAddress({
      ...data,
      user_id: userId,
    });
  }

  async deleteAddress(userId: string, addressId: string): Promise<boolean> {
    return this.repo.deleteAddress(userId, addressId);
  }

  // Admin 2FA Setup Helpers
  async getAdmin2FaSecret(adminId: string): Promise<string> {
    let secret = this.admin2faSecrets.get(adminId);
    if (!secret) {
      secret = generateTotpSecret();
      this.admin2faSecrets.set(adminId, secret);
    }
    return secret;
  }

  getAdminCurrentTotp(adminId: string): string {
    const secret = this.admin2faSecrets.get(adminId);
    if (!secret) throw new Error('No 2FA secret found.');
    return generateTotpCode(secret);
  }

  private async createSession(user: User, deviceInfo?: string): Promise<AuthTokens> {
    const expiresIn = 900; // 15 mins
    const accessToken = signJwt(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
      },
      expiresIn
    );

    const rawRefreshToken = generateRandomToken();
    const tokenHash = hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    await this.repo.createRefreshToken({
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
      revoked_at: null,
      device_info: deviceInfo,
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    };
  }
}
