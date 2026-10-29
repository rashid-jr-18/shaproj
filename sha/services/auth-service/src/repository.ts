/**
 * @file services/auth-service/src/repository.ts
 * Auth Service Data Repository
 */

import * as crypto from 'node:crypto';
import type { User, Address, RefreshToken } from '../../../packages/types/src/index.ts';
import { hashPassword } from './crypto.ts';

export interface IAuthRepository {
  findUserByEmail(email: string): Promise<User | null>;
  findUserByPhone(phone: string): Promise<User | null>;
  findUserById(id: string): Promise<User | null>;
  createUser(user: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | null>;
  
  createRefreshToken(token: Omit<RefreshToken, 'id'>): Promise<RefreshToken>;
  findRefreshToken(tokenHash: string): Promise<RefreshToken | null>;
  revokeRefreshToken(id: string): Promise<void>;
  revokeAllUserTokens(userId: string): Promise<void>;

  getAddresses(userId: string): Promise<Address[]>;
  addAddress(address: Omit<Address, 'id' | 'created_at'>): Promise<Address>;
  deleteAddress(userId: string, addressId: string): Promise<boolean>;
}

export class InMemoryAuthRepository implements IAuthRepository {
  private users = new Map<string, User>();
  private refreshTokens = new Map<string, RefreshToken>();
  private addresses = new Map<string, Address>();

  constructor() {
    this.seedDefaultAdmin();
  }

  private seedDefaultAdmin() {
    const adminId = '00000000-0000-0000-0000-000000000001';
    const admin: User = {
      id: adminId,
      name: 'Hira Store Owner',
      email: 'admin@hira.in',
      phone: '+919876543210',
      password_hash: hashPassword('HiraAdminSecure2026!'),
      role: 'ADMIN',
      status: 'ACTIVE',
      email_verified_at: new Date().toISOString(),
      failed_attempts: 0,
      locked_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.users.set(adminId, admin);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const normalized = email.toLowerCase().trim();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === normalized) {
        return { ...u };
      }
    }
    return null;
  }

  async findUserByPhone(phone: string): Promise<User | null> {
    const clean = phone.replace(/\D/g, '').slice(-10);
    if (!clean) return null;
    for (const u of this.users.values()) {
      if (u.phone && u.phone.replace(/\D/g, '').slice(-10) === clean) {
        return { ...u };
      }
    }
    return null;
  }

  async findUserById(id: string): Promise<User | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async createUser(data: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const user: User = {
      ...data,
      id,
      email: data.email.toLowerCase().trim(),
      created_at: now,
      updated_at: now,
    };
    this.users.set(id, user);
    return { ...user };
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | null> {
    const existing = this.users.get(id);
    if (!existing) return null;
    const updated: User = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    this.users.set(id, updated);
    return { ...updated };
  }

  async createRefreshToken(data: Omit<RefreshToken, 'id'>): Promise<RefreshToken> {
    const id = crypto.randomUUID();
    const token: RefreshToken = { ...data, id };
    this.refreshTokens.set(id, token);
    return { ...token };
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshToken | null> {
    for (const token of this.refreshTokens.values()) {
      if (token.token_hash === tokenHash) {
        return { ...token };
      }
    }
    return null;
  }

  async revokeRefreshToken(id: string): Promise<void> {
    const token = this.refreshTokens.get(id);
    if (token) {
      token.revoked_at = new Date().toISOString();
      this.refreshTokens.set(id, token);
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const [id, token] of this.refreshTokens.entries()) {
      if (token.user_id === userId && !token.revoked_at) {
        token.revoked_at = now;
        this.refreshTokens.set(id, token);
      }
    }
  }

  async getAddresses(userId: string): Promise<Address[]> {
    const list: Address[] = [];
    for (const addr of this.addresses.values()) {
      if (addr.user_id === userId) {
        list.push({ ...addr });
      }
    }
    return list;
  }

  async addAddress(data: Omit<Address, 'id' | 'created_at'>): Promise<Address> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const address: Address = { ...data, id, created_at: now };
    this.addresses.set(id, address);
    return { ...address };
  }

  async deleteAddress(userId: string, addressId: string): Promise<boolean> {
    const addr = this.addresses.get(addressId);
    if (!addr || addr.user_id !== userId) return false;
    return this.addresses.delete(addressId);
  }
}
