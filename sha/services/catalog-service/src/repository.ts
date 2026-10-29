/**
 * @file services/catalog-service/src/repository.ts
 * Catalog Repository with Soft-Delete, Search & Category filtering
 */

import * as crypto from 'node:crypto';
import type { Product, Category, ProductImage, ProductStatus } from '../../../packages/types/src/index.ts';

export interface ProductFilter {
  categorySlug?: string;
  search?: string;
  includeUnavailable?: boolean; // admin only
  includeArchived?: boolean;    // admin only
  sort?: 'price_asc' | 'price_desc' | 'newest';
  page?: number;
  limit?: number;
}

export interface ICatalogRepository {
  getCategories(): Promise<Category[]>;
  getCategoryById(id: string): Promise<Category | null>;
  getOrCreateCategory(name: string): Promise<Category>;

  getProducts(filter: ProductFilter): Promise<{ products: Product[]; total: number }>;
  getProductById(id: string): Promise<Product | null>;
  getProductBySlug(slug: string): Promise<Product | null>;
  createProduct(data: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product>;
  updateProduct(id: string, updates: Partial<Product>): Promise<Product | null>;
  archiveProduct(id: string): Promise<boolean>;
}

export class InMemoryCatalogRepository implements ICatalogRepository {
  private categories = new Map<string, Category>();
  private products = new Map<string, Product>();

  async getCategories(): Promise<Category[]> {
    return Array.from(this.categories.values());
  }

  async getCategoryById(id: string): Promise<Category | null> {
    return this.categories.get(id) || null;
  }

  async getOrCreateCategory(name: string): Promise<Category> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    for (const cat of this.categories.values()) {
      if (cat.slug === slug || cat.name.toLowerCase() === name.toLowerCase()) {
        return { ...cat };
      }
    }
    const id = crypto.randomUUID();
    const newCat: Category = {
      id,
      name: name.trim(),
      slug,
      created_at: new Date().toISOString(),
    };
    this.categories.set(id, newCat);
    return { ...newCat };
  }

  async getProducts(filter: ProductFilter): Promise<{ products: Product[]; total: number }> {
    let list = Array.from(this.products.values());

    // 1. Status Filter: Public customers see only ACTIVE products
    if (!filter.includeArchived) {
      list = list.filter((p) => p.status !== 'ARCHIVED');
    }
    if (!filter.includeUnavailable) {
      list = list.filter((p) => p.status === 'ACTIVE');
    }

    // 2. Category Filter
    if (filter.categorySlug) {
      const cat = Array.from(this.categories.values()).find((c) => c.slug === filter.categorySlug);
      if (cat) {
        list = list.filter((p) => p.category_id === cat.id);
      } else {
        return { products: [], total: 0 };
      }
    }

    // 3. Search Filter (matches name, description, or SKU)
    if (filter.search && filter.search.trim()) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q)
      );
    }

    // 4. Sort
    if (filter.sort === 'price_asc') {
      list.sort((a, b) => a.price - b.price);
    } else if (filter.sort === 'price_desc') {
      list.sort((a, b) => b.price - a.price);
    } else {
      // Newest by default
      list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    const total = list.length;
    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 20;
    const start = (page - 1) * limit;
    const paginated = list.slice(start, start + limit).map((p) => ({
      ...p,
      category: this.categories.get(p.category_id),
    }));

    return { products: paginated, total };
  }

  async getProductById(id: string): Promise<Product | null> {
    const p = this.products.get(id);
    if (!p) return null;
    return {
      ...p,
      category: this.categories.get(p.category_id),
    };
  }

  async getProductBySlug(slug: string): Promise<Product | null> {
    for (const p of this.products.values()) {
      if (p.slug === slug) {
        return {
          ...p,
          category: this.categories.get(p.category_id),
        };
      }
    }
    return null;
  }

  async createProduct(data: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product> {
    // Enforce SKU Uniqueness (Section 5)
    for (const existing of this.products.values()) {
      if (existing.sku.toLowerCase() === data.sku.toLowerCase()) {
        return {
          ...existing,
          category: this.categories.get(existing.category_id),
        };
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const p: Product = {
      ...data,
      id,
      created_at: now,
      updated_at: now,
    };
    this.products.set(id, p);
    return {
      ...p,
      category: this.categories.get(p.category_id),
    };
  }

  async updateProduct(id: string, updates: Partial<Product>): Promise<Product | null> {
    const existing = this.products.get(id);
    if (!existing) return null;
    const updated: Product = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
    };
    this.products.set(id, updated);
    return {
      ...updated,
      category: this.categories.get(updated.category_id),
    };
  }

  async archiveProduct(id: string): Promise<boolean> {
    const existing = this.products.get(id);
    if (!existing) return false;
    existing.status = 'ARCHIVED';
    existing.deleted_at = new Date().toISOString();
    existing.updated_at = new Date().toISOString();
    this.products.set(id, existing);
    return true;
  }
}
