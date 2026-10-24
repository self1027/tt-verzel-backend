import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { auctions } from '../../modules/auctions/infrastructure/schema.js';
import { DrizzleAuditAppender } from '../../modules/audit/repositories/drizzle-audit-appender.js';
import { productSnapshots } from '../../modules/catalog/infrastructure/schema.js';
import { ledgerAccounts, ledgerEntries } from '../../modules/ledger/infrastructure/schema.js';
import { users } from '../../modules/users/infrastructure/schema.js';
import { wallets, walletReservations } from '../../modules/wallets/infrastructure/schema.js';
import { DrizzleWalletRepository } from '../../modules/wallets/repositories/drizzle-wallet-repository.js';
import { WalletService } from '../../modules/wallets/services/wallet-service.js';
import { demoProduct } from './demo-product.js';

const snapshotId = 'd3b80001-34ef-4000-8000-000000000001';
const auctionId = 'd3b80001-34ef-4000-8000-000000000002';
const bidderEmails = ['bidder1@verzel.local', 'bidder2@verzel.local'];

/** Optional demonstration data; call only after the foundational seed. */
export async function seedDemonstration(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742193, 2)`);
    const [owner] = await tx.select().from(users).where(eq(users.email, 'auctioneer@verzel.local'));
    const bidders = await tx.select().from(users).where(inArray(users.email, bidderEmails));
    if (owner?.role !== 'AUCTIONEER' || bidders.length !== 2 || bidders.some((user) => user.role !== 'BIDDER')) {
      throw new Error('Run the foundational seed before the demonstration seed');
    }
    // Lock financial rows before creating/locking the demo auction, in stable order.
    const bidderWallets = await tx.select().from(wallets).where(inArray(wallets.userId, bidders.map((user) => user.id)))
      .orderBy(asc(wallets.id)).for('update');
    if (bidderWallets.length !== 2) throw new Error('Demonstration bidder wallets are missing');
    const funding = new WalletService(new DrizzleWalletRepository(tx));
    for (const wallet of bidderWallets) {
      if (wallet.balanceCents !== 0n || wallet.reservedCents !== 0n) continue;
      const [account] = await tx.select().from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.walletId, wallet.id), eq(ledgerAccounts.type, 'USER_WALLET')));
      if (!account) throw new Error('Demonstration wallet ledger account is missing');
      const [history] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.accountId, account.id)).limit(1);
      const [reservation] = await tx.select({ id: walletReservations.id }).from(walletReservations).where(eq(walletReservations.walletId, wallet.id)).limit(1);
      if (!history && !reservation) await funding.deposit(wallet.userId, 100000n, 'demo-bootstrap-v1');
    }
    const [existing] = await tx.select({ id: auctions.id }).from(auctions).where(eq(auctions.id, auctionId));
    if (existing) return;
    const result = await tx.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    const timestamp = result.rows[0]?.now;
    if (!timestamp) throw new Error('Database clock returned no value');
    const now = new Date(timestamp);
    await tx.insert(productSnapshots).values({
      id: snapshotId, externalId: String(demoProduct.id), source: 'dummyjson-demo-fixture', title: demoProduct.title,
      description: demoProduct.description, imageUrl: demoProduct.imageUrl, capturedAt: now,
      attributes: { ...demoProduct.attributes, demoProvenance: 'tests/fixtures/dummyjson/product_1.json; public whitelist; offline demo v1' },
    }).onConflictDoNothing({ target: productSnapshots.id });
    const createdAt = new Date(+now - 2000);
    const startsAt = new Date(+now - 1000);
    const endsAt = new Date(+now + 7200000);
    await tx.insert(auctions).values({ id: auctionId, auctioneerId: owner.id, productSnapshotId: snapshotId,
      currentBidId: null, startingBidCents: 1000n, minIncrementCents: 100n,
      startsAt, endsAt, status: 'PUBLISHED', createdAt, updatedAt: createdAt });
    await new DrizzleAuditAppender(tx).append({ auctionId, eventType: 'AUCTION_CREATED', createdAt: createdAt.toISOString(),
      payload: { productSnapshotId: snapshotId, startingBidCents: '1000', minIncrementCents: '100',
        startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), status: 'PUBLISHED', currentBidId: null } });
  });
}
