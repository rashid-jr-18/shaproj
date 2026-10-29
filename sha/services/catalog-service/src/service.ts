/**
 * @file services/catalog-service/src/service.ts
 * Catalog Service Business Logic & CSV Bulk Importer
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Product,
  Category,
  CatalogProductView,
  ProductStatus,
} from '../../../packages/types/src/index.ts';
import { computeAvailability } from '../../../packages/ui/src/index.ts';
import type { ICatalogRepository, ProductFilter } from './repository.ts';

export interface CsvProductRow {
  sku: string;
  name: string;
  slug: string;
  category: string;
  price: number;
  mrp: number;
  tax_rate: number;
  description: string;
  stock: number;
  low_stock_threshold: number;
  image_url?: string;
}

export class CatalogService {
  private repo: ICatalogRepository;
  private inventoryCallback?: (productId: string, stock: number, threshold: number) => Promise<any>;

  constructor(
    repo: ICatalogRepository,
    inventoryCallback?: (productId: string, stock: number, threshold: number) => Promise<any>
  ) {
    this.repo = repo;
    this.inventoryCallback = inventoryCallback;
  }

  async getCategories(): Promise<Category[]> {
    return this.repo.getCategories();
  }

  async getProducts(
    filter: ProductFilter,
    inventoryMap?: Map<string, { on_hand: number; reserved: number; low_stock_threshold: number }>
  ): Promise<{ products: CatalogProductView[]; total: number }> {
    const { products, total } = await this.repo.getProducts(filter);

    const projected: CatalogProductView[] = products.map((p) => {
      const inv = inventoryMap?.get(p.id) || {
        on_hand: 10,
        reserved: 0,
        low_stock_threshold: 3,
      };
      const available = Math.max(0, inv.on_hand - inv.reserved);
      const availability = computeAvailability(inv.on_hand, inv.reserved, inv.low_stock_threshold, p.status);
      const imageUrl = p.images?.[0]?.url || 'https://images.unsplash.com/photo-1597983073493-88cd35cf93b0?auto=format&fit=crop&w=600&q=80';
      return {
        ...p,
        image_url: imageUrl,
        available_stock: available,
        availability,
      } as any;
    });

    return { products: projected, total };
  }

  async getProductBySlug(
    slug: string,
    inventoryData?: { on_hand: number; reserved: number; low_stock_threshold: number }
  ): Promise<CatalogProductView | null> {
    const p = await this.repo.getProductBySlug(slug);
    if (!p) return null;

    const inv = inventoryData || { on_hand: 10, reserved: 0, low_stock_threshold: 3 };
    const available = Math.max(0, inv.on_hand - inv.reserved);
    const availability = computeAvailability(inv.on_hand, inv.reserved, inv.low_stock_threshold, p.status);
    const imageUrl = p.images?.[0]?.url || 'https://images.unsplash.com/photo-1597983073493-88cd35cf93b0?auto=format&fit=crop&w=600&q=80';

    return {
      ...p,
      image_url: imageUrl,
      available_stock: available,
      availability,
    } as any;
  }

  async createProduct(data: {
    sku: string;
    name: string;
    slug?: string;
    description: string;
    categoryName: string;
    price: number; // paise
    mrp: number;   // paise
    tax_rate?: number;
    initialStock?: number;
    lowStockThreshold?: number;
    imageUrl?: string;
  }): Promise<Product> {
    const category = await this.repo.getOrCreateCategory(data.categoryName);
    const slug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const imgUrl = data.imageUrl || 'https://images.unsplash.com/photo-1597983073493-88cd35cf93b0?auto=format&fit=crop&w=600&q=80';

    const product = await this.repo.createProduct({
      sku: data.sku.trim(),
      name: data.name.trim(),
      slug,
      description: data.description.trim(),
      category_id: category.id,
      price: Math.round(data.price),
      mrp: Math.round(data.mrp),
      tax_rate: data.tax_rate ?? 5,
      status: 'ACTIVE',
      images: [
        {
          id: `img-${Date.now()}`,
          product_id: '',
          url: imgUrl,
          alt: data.name,
          sort_order: 1,
        },
      ],
      deleted_at: null,
    });

    if (this.inventoryCallback && data.initialStock !== undefined) {
      await this.inventoryCallback(product.id, data.initialStock, data.lowStockThreshold || 3);
    }

    return product;
  }

  async updatePrice(productId: string, newPricePaise: number): Promise<Product | null> {
    if (newPricePaise <= 0) throw new Error('Price must be greater than zero.');
    return this.repo.updateProduct(productId, { price: Math.round(newPricePaise) });
  }

  async setAvailability(productId: string, status: 'ACTIVE' | 'UNAVAILABLE'): Promise<Product | null> {
    return this.repo.updateProduct(productId, { status });
  }

  async archiveProduct(productId: string): Promise<boolean> {
    return this.repo.archiveProduct(productId);
  }

  /**
   * Section 6.4: Bulk import of the first 50 products via CSV
   */
  async importProductsFromCsv(csvContent: string): Promise<{ importedCount: number; errors: string[] }> {
    const lines = csvContent.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      return { importedCount: 0, errors: ['CSV file is empty or missing headers'] };
    }

    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const errors: string[] = [];
    let count = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      // Basic CSV field parser supporting simple commas
      const values = line.split(',').map((v) => v.trim());
      if (values.length < 10) {
        errors.push(`Row ${i + 1}: Missing required columns`);
        continue;
      }

      const sku = values[0];
      const name = values[1];
      const slug = values[2];
      const category = values[3];
      const priceStr = values[4];
      const mrpStr = values[5];
      const taxStr = values[6];
      const imageUrl = values.length >= 11 ? values[values.length - 1] : undefined;
      const thresholdStr = values.length >= 11 ? values[values.length - 2] : values[9];
      const stockStr = values.length >= 11 ? values[values.length - 3] : values[8];
      const desc = values.length >= 11 ? values.slice(7, values.length - 3).join(', ') : values[7];

      try {
        await this.createProduct({
          sku,
          name,
          slug,
          categoryName: category,
          price: parseInt(priceStr, 10),
          mrp: parseInt(mrpStr, 10),
          tax_rate: parseInt(taxStr, 10),
          description: desc,
          initialStock: parseInt(stockStr, 10),
          lowStockThreshold: parseInt(thresholdStr, 10),
          imageUrl: imageUrl || undefined,
        });
        count++;
      } catch (err: any) {
        errors.push(`Row ${i + 1} (${sku}): ${err.message}`);
      }
    }

    return { importedCount: count, errors };
  }
}

