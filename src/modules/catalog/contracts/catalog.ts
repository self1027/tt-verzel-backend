export interface Pagination {
  limit: number;
  skip: number;
}

export interface ProductPage<T> extends Pagination {
  products: T[];
  total: number;
}

export interface ExternalListInput extends Pagination {
  category?: string | undefined;
}

export interface ExternalProduct {
  id: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  attributes: Record<string, unknown>;
}

export interface ProductProvider {
  list(input: ExternalListInput): Promise<ProductPage<ExternalProduct>>;
  search(query: string, page: Pagination): Promise<ProductPage<ExternalProduct>>;
  getById(id: number): Promise<ExternalProduct>;
  categories(): Promise<string[]>;
}

export interface ProductSnapshot {
  id: string;
  externalId: string;
  source: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  attributes: unknown;
  capturedAt: Date;
}

export type SnapshotInput = Omit<ProductSnapshot, 'id' | 'capturedAt'>;

export interface ImportResult {
  product: ProductSnapshot;
  created: boolean;
}

export interface SnapshotRepository {
  findByExternalId(source: string, externalId: string): Promise<ProductSnapshot | null>;
  createIfAbsent(input: SnapshotInput): Promise<ImportResult>;
  list(page: Pagination, query?: string): Promise<ProductPage<ProductSnapshot>>;
  findById(id: string): Promise<ProductSnapshot | null>;
}

export interface CatalogUseCases {
  listExternal(input: ExternalListInput): Promise<ProductPage<ExternalProduct>>;
  searchExternal(query: string, page: Pagination): Promise<ProductPage<ExternalProduct>>;
  getExternal(id: number): Promise<ExternalProduct>;
  listCategories(): Promise<string[]>;
  importProduct(id: number): Promise<ImportResult>;
  listProducts(page: Pagination, query?: string): Promise<ProductPage<ProductSnapshot>>;
  getProduct(id: string): Promise<ProductSnapshot>;
}
