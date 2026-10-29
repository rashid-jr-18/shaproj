/**
 * @file services/catalog-service/tests/catalog.test.ts
 * Catalog Service & 50 Products CSV Importer Unit Tests
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { InMemoryCatalogRepository } from '../src/repository.ts';
import { CatalogService } from '../src/service.ts';

describe('Catalog Service & 50 Products CSV Import Tests', () => {
  const repo = new InMemoryCatalogRepository();
  const stockStore = new Map<string, number>();

  const service = new CatalogService(repo, async (productId, stock) => {
    stockStore.set(productId, stock);
  });

  it('should successfully bulk import all 50 products from infra/seeds/products.csv', async () => {
    const csvPath = path.resolve(process.cwd(), 'infra/seeds/products.csv');
    assert.ok(fs.existsSync(csvPath), 'infra/seeds/products.csv must exist');

    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const result = await service.importProductsFromCsv(csvContent);

    assert.strictEqual(result.errors.length, 0, `CSV import errors: ${result.errors.join(', ')}`);
    assert.strictEqual(result.importedCount, 50, 'All 50 initial products must be imported');

    // Verify categories created
    const categories = await service.getCategories();
    assert.ok(categories.length >= 6, 'Multiple categories should be auto-created');

    const { products, total } = await service.getProducts({});
    assert.strictEqual(total, 50, 'Total active products must be 50');
  });

  it('should search products by keyword and SKU', async () => {
    const searchKurta = await service.getProducts({ search: 'Kurt' });
    assert.ok(searchKurta.total >= 3, 'Should find kurta products');

    const searchSku = await service.getProducts({ search: 'HRA-KUR-001' });
    assert.strictEqual(searchSku.total, 1);
    assert.strictEqual(searchSku.products[0].sku, 'HRA-KUR-001');
  });

  it('should sort products by price ascending and descending', async () => {
    const asc = await service.getProducts({ sort: 'price_asc' });
    for (let i = 0; i < asc.products.length - 1; i++) {
      assert.ok(asc.products[i].price <= asc.products[i + 1].price, 'Ascending sort order check');
    }

    const desc = await service.getProducts({ sort: 'price_desc' });
    for (let i = 0; i < desc.products.length - 1; i++) {
      assert.ok(desc.products[i].price >= desc.products[i + 1].price, 'Descending sort order check');
    }
  });

  it('should toggle UNAVAILABLE and immediately hide product from public customer listing (Section 6.4)', async () => {
    const kurta = await repo.getProductBySlug('pure-cotton-handblock-kurta-peacock-blue');
    assert.ok(kurta);

    // Admin toggles UNAVAILABLE
    await service.setAvailability(kurta.id, 'UNAVAILABLE');

    // Public listing must NOT include it
    const publicList = await service.getProducts({ search: 'Peacock Blue' });
    assert.strictEqual(publicList.total, 0, 'Unavailable product must not appear in customer listing');

    // Admin listing (includeUnavailable: true) MUST include it
    const adminList = await repo.getProducts({ search: 'Peacock Blue', includeUnavailable: true });
    assert.strictEqual(adminList.total, 1);
    assert.strictEqual(adminList.products[0].status, 'UNAVAILABLE');

    // Re-enable
    await service.setAvailability(kurta.id, 'ACTIVE');
    const restored = await service.getProducts({ search: 'Peacock Blue' });
    assert.strictEqual(restored.total, 1);
  });

  it('should update price and affect only subsequent orders (Section 6.4)', async () => {
    const kurta = await repo.getProductBySlug('pure-cotton-handblock-kurta-peacock-blue');
    assert.ok(kurta);
    const oldPrice = kurta.price;

    const newPricePaise = 159900; // ₹1,599
    await service.updatePrice(kurta.id, newPricePaise);

    const updated = await repo.getProductById(kurta.id);
    assert.strictEqual(updated?.price, newPricePaise);
    assert.notStrictEqual(updated?.price, oldPrice);
  });

  it('should soft-delete (archive) products without destroying historical record (Section 2.2 #8)', async () => {
    const item = await repo.getProductBySlug('handmade-ceramic-chai-kulhad-set-of-6');
    assert.ok(item);

    const archived = await service.archiveProduct(item.id);
    assert.strictEqual(archived, true);

    // Public list excludes archived
    const publicList = await service.getProducts({ search: 'Chai Kulhad' });
    assert.strictEqual(publicList.total, 0);

    // Database still contains it with deleted_at timestamp
    const record = await repo.getProductById(item.id);
    assert.ok(record);
    assert.strictEqual(record?.status, 'ARCHIVED');
    assert.ok(record?.deleted_at);
  });
});
