import type { CatalogUseCases, ExternalListInput, ExternalProduct, ImportResult, Pagination, ProductPage, ProductProvider, ProductSnapshot, SnapshotRepository } from '../contracts/catalog.js';
import { AppError } from '../../../shared/http/app-error.js';

export class CatalogService implements CatalogUseCases {
  constructor(private readonly provider: ProductProvider, private readonly snapshots: SnapshotRepository) {}

  listExternal(input: ExternalListInput): Promise<ProductPage<ExternalProduct>> {
    return this.provider.list(input);
  }

  searchExternal(query: string, page: Pagination): Promise<ProductPage<ExternalProduct>> {
    return this.provider.search(query, page);
  }

  getExternal(id: number): Promise<ExternalProduct> {
    return this.provider.getById(id);
  }

  listCategories(): Promise<string[]> {
    return this.provider.categories();
  }

  async importProduct(id: number): Promise<ImportResult> {
    const externalId = String(id);
    const source = 'dummyjson';
    const existing = await this.snapshots.findByExternalId(source, externalId);
    if (existing) return { product: existing, created: false };
    const product = await this.provider.getById(id);
    return this.snapshots.createIfAbsent({
      externalId, source, title: product.title, description: product.description,
      imageUrl: product.imageUrl, attributes: product.attributes,
    });
  }

  listProducts(page: Pagination, query?: string): Promise<ProductPage<ProductSnapshot>> {
    return this.snapshots.list(page, query);
  }

  async getProduct(id: string): Promise<ProductSnapshot> {
    const product = await this.snapshots.findById(id);
    if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product snapshot not found');
    return product;
  }
}
