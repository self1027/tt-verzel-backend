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
import { demoProducts } from './demo-products.js';
import { auditEvents } from '../../modules/audit/infrastructure/schema.js';

const demoId = (value: number) => `d3b80001-34ef-4000-8000-${String(value).padStart(12, '0')}`;
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
    const result = await tx.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    const timestamp = result.rows[0]?.now;
    if (!timestamp) throw new Error('Database clock returned no value');
    const now = new Date(timestamp);
    for (const [index, product] of demoProducts.entries()) {
      const snapshotId = demoId(index * 2 + 1);
      const auctionId = demoId(index * 2 + 2);
      const [existing] = await tx.select({ id: auctions.id }).from(auctions).where(eq(auctions.id, auctionId));
      if (existing) continue;
      const closed = index >= 18;
      const scheduled = index >= 14 && index < 18;
      const scenario = index === 21 ? 'tampered-price' : index === 22 ? 'tampered-dates'
        : index === 23 ? 'tampered-event' : closed ? 'closed-no-bids' : scheduled ? 'scheduled' : 'live';
      await tx.insert(productSnapshots).values({
        id: snapshotId, externalId: String(product.id), source: index === 0 ? 'dummyjson-demo-fixture' : 'local-demo-catalog',
        title: product.title, description: product.description, imageUrl: product.imageUrl, capturedAt: now,
        attributes: { ...product.attributes, demoScenario: scenario,
          demoProvenance: index === 0 ? 'tests/fixtures/dummyjson/product_1.json; public whitelist; offline demo v1'
            : 'src/shared/database/demo-products.ts; curated offline demo v2' },
      }).onConflictDoNothing({ target: productSnapshots.id });
      const startsAt = new Date(+now + (closed ? -(index + 1) * 86400000 : scheduled ? (index - 13) * 86400000 : -1000));
      const createdAt = new Date(Math.min(+now - 2000, +startsAt - 3600000));
      const endsAt = new Date(+startsAt + (closed ? 7200000 : scheduled ? 86400000 : 7201000 + index * 3600000));
      const startingBidCents = BigInt(1000 + index * 1250);
      const minIncrementCents = BigInt(100 + (index % 4) * 50);
      await tx.insert(auctions).values({ id: auctionId, auctioneerId: owner.id, productSnapshotId: snapshotId,
        currentBidId: null, startingBidCents, minIncrementCents,
        startsAt, endsAt, status: 'PUBLISHED', createdAt, updatedAt: createdAt });
      const audit = new DrizzleAuditAppender(tx);
      await audit.append({ auctionId, eventType: 'AUCTION_CREATED', createdAt: createdAt.toISOString(),
        payload: { productSnapshotId: snapshotId, startingBidCents: String(startingBidCents), minIncrementCents: String(minIncrementCents),
          startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), status: 'PUBLISHED', currentBidId: null } });
      if (closed) {
        const closedAt = new Date(+endsAt + 1000);
        await tx.update(auctions).set({ status: 'CLOSED_NO_BIDS', updatedAt: closedAt }).where(eq(auctions.id, auctionId));
        await audit.append({ auctionId, eventType: 'AUCTION_CLOSED_NO_BIDS', createdAt: closedAt.toISOString(), payload: {} });
      }
      // Deliberate demo attacks after a valid close: preserve the original commitments.
      if (scenario === 'tampered-price') {
        await tx.update(auctions).set({ startingBidCents: startingBidCents + 50000n }).where(eq(auctions.id, auctionId));
      } else if (scenario === 'tampered-dates') {
        await tx.update(auctions).set({ endsAt: new Date(+endsAt + 3600000) }).where(eq(auctions.id, auctionId));
      } else if (scenario === 'tampered-event') {
        await tx.update(auditEvents).set({ payload: { reason: 'DEMO_FORGED_CLOSE' } })
          .where(and(eq(auditEvents.auctionId, auctionId), eq(auditEvents.eventType, 'AUCTION_CLOSED_NO_BIDS')));
      }
    }
  });
}
