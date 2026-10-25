import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import type { ImportResult, Pagination, ProductPage, ProductSnapshot, SnapshotInput, SnapshotRepository } from '../contracts/catalog.js';
import { productSnapshots } from '../infrastructure/schema.js';

export class DrizzleSnapshotRepository implements SnapshotRepository {
  constructor(private readonly db: Database) {}

  async findByExternalId(source: string, externalId: string): Promise<ProductSnapshot | null> {
    const [product] = await this.db.select().from(productSnapshots)
      .where(and(eq(productSnapshots.source, source), eq(productSnapshots.externalId, externalId)))
      .orderBy(asc(productSnapshots.capturedAt), asc(productSnapshots.id)).limit(1);
    return product ?? null;
  }

  createIfAbsent(input: SnapshotInput): Promise<ImportResult> {
    return this.db.transaction(async (tx) => {
      // All catalog imports share this lock because the existing schema has no source/id uniqueness.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'catalog:' + input.source}), hashtext(${input.externalId}))`);
      const [existing] = await tx.select().from(productSnapshots)
        .where(and(eq(productSnapshots.source, input.source), eq(productSnapshots.externalId, input.externalId)))
        .orderBy(asc(productSnapshots.capturedAt), asc(productSnapshots.id)).limit(1);
      if (existing) return { product: existing, created: false };
      const [product] = await tx.insert(productSnapshots).values({
        ...input, id: randomUUID(), capturedAt: new Date(),
      }).returning();
      if (!product) throw new Error('Snapshot insert returned no record');
      return { product, created: true };
    });
  }

  async list(page: Pagination, query?: string): Promise<ProductPage<ProductSnapshot>> {
    return this.db.transaction(async (tx) => {
      const search = query?.trim();
      const filter = search ? or(
        ilike(productSnapshots.title, `%${search}%`),
        ilike(productSnapshots.description, `%${search}%`),
        ilike(productSnapshots.externalId, `%${search}%`),
      ) : undefined;
      const products = await tx.select().from(productSnapshots)
        .where(filter).orderBy(desc(productSnapshots.capturedAt), asc(productSnapshots.id)).limit(page.limit).offset(page.skip);
      const [total] = await tx.select({ value: count() }).from(productSnapshots).where(filter);
      return { products, total: total?.value ?? 0, ...page };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async findById(id: string): Promise<ProductSnapshot | null> {
    const [product] = await this.db.select().from(productSnapshots).where(eq(productSnapshots.id, id)).limit(1);
    return product ?? null;
  }
}
