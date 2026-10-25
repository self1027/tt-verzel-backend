import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import type { AnchorPublisher, AnchorVerifier } from '../../modules/audit/contracts/anchors.js';
import { auctions, productSnapshots, users, wallets, ledgerAccounts, ledgerEntries, walletReservations } from './schema.js';
import { AuctionService } from '../../modules/auctions/services/auction-service.js';
import { DrizzleAuctionRepository } from '../../modules/auctions/repositories/drizzle-auction-repository.js';
import { DrizzleAuditAppender } from '../../modules/audit/repositories/drizzle-audit-appender.js';
import { DrizzleAuditRepository } from '../../modules/audit/repositories/drizzle-audit-repository.js';
import { inspectSnapshot } from '../../modules/audit/services/audit-verifier.js';
import { WalletService } from '../../modules/wallets/services/wallet-service.js';
import { DrizzleWalletRepository } from '../../modules/wallets/repositories/drizzle-wallet-repository.js';
import { BidService } from '../../modules/bids/services/bid-service.js';
import { DrizzleBidRepository } from '../../modules/bids/repositories/drizzle-bid-repository.js';
import { DrizzleBidQueryRepository } from '../../modules/bids/repositories/drizzle-bid-query-repository.js';
import { DrizzleReservationOperations } from '../../modules/wallets/repositories/drizzle-reservation-operations.js';
import { SettlementService } from '../../modules/settlements/services/settlement-service.js';
import { DrizzleSettlementRepository } from '../../modules/settlements/repositories/drizzle-settlement-repository.js';
import { DrizzleSettlementAuditGate } from '../../modules/settlements/infrastructure/settlement-proof.js';
import { AppError } from '../http/app-error.js';
import { demoProducts } from './demo-products.js';

const scenarios = ['scheduled', 'live', 'live-bids', 'settled', 'closed-no-bids', 'cancelled'] as const;
type Scenario = typeof scenarios[number];
export interface DemoSeedOptions { external?: AnchorPublisher & AnchorVerifier; waitForSettlement?: boolean }

async function clock(db: Database): Promise<Date> {
  const result = await db.execute<{ at: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
  const at = result.rows[0]?.at; if (!at) throw new Error('Database clock unavailable'); return new Date(at);
}

async function waitUntil(db: Database, at: Date): Promise<void> {
  for (let remaining = +at - +(await clock(db)); remaining > 0; remaining = +at - +(await clock(db))) {
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 250)));
  }
}

async function fundPristineWallets(db: Database, bidderIds: string[]): Promise<void> {
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742193, 2)`);
    const rows = await tx.select().from(wallets).where(inArray(wallets.userId, bidderIds)).orderBy(asc(wallets.id)).for('update');
    if (rows.length !== 2) throw new Error('Demonstration bidder wallets are missing');
    for (const wallet of rows) {
      if (wallet.balanceCents !== 0n || wallet.reservedCents !== 0n) continue;
      const [account] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.walletId, wallet.id), eq(ledgerAccounts.type, 'USER_WALLET')));
      if (!account) throw new Error('Demonstration ledger account missing');
      const [history] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.accountId, account.id)).limit(1);
      const [reservation] = await tx.select({ id: walletReservations.id }).from(walletReservations).where(eq(walletReservations.walletId, wallet.id)).limit(1);
      if (!history && !reservation) await new WalletService(new DrizzleWalletRepository(tx)).deposit(wallet.userId, 100000n, 'demo-bootstrap-v1');
    }
  });
}

async function ensureAuction(db: Database, ownerId: string, scenario: Scenario, index: number) {
  return db.transaction(async tx => {
    // Only creation is serialized; no external calls or wallet locks are held here.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(742193, 3)`);
    const snapshotId = `d3b80003-34ef-4000-8000-${String(index + 1).padStart(12, '0')}`;
    const service = new AuctionService(new DrizzleAuctionRepository(tx, context => new DrizzleAuditAppender(context)));
    const [existing] = await tx.select().from(auctions).where(eq(auctions.productSnapshotId, snapshotId));
    if (existing) {
      if (existing.auctioneerId !== ownerId) throw new Error('Demonstration owner conflict');
      return service.get(existing.id);
    }
    const product = demoProducts[index]; if (!product) throw new Error('Demonstration product missing');
    const [snapshot] = await tx.select().from(productSnapshots).where(eq(productSnapshots.id, snapshotId));
    if (snapshot) throw new Error('Demonstration snapshot conflict; existing data was preserved');
    const now = await clock(tx);
    await tx.insert(productSnapshots).values({ id: snapshotId, externalId: String(product.id),
      source: index === 0 ? 'dummyjson-demo-fixture' : 'local-demo-catalog', title: product.title,
      description: product.description, imageUrl: product.imageUrl, capturedAt: now,
      attributes: { ...product.attributes, demoScenario: scenario, demoSeedVersion: 3 } });
    const future = scenario === 'scheduled' || scenario === 'cancelled';
    const startsAt = new Date(+now + (future ? 86400000 : 300));
    const duration = scenario === 'settled' ? 150000 : scenario === 'closed-no-bids' ? 500 : 86400000;
    return service.create(ownerId, { productSnapshotId: snapshotId, startingBidCents: 5000n,
      minIncrementCents: 500n, startsAt, endsAt: new Date(+startsAt + duration) });
  });
}

async function publishDemoHead(db: Database, id: string, external: AnchorPublisher & AnchorVerifier): Promise<void> {
  const snapshot = await new DrizzleAuditRepository(db).snapshot(id);
  if (!snapshot) throw new Error('Demonstration auction missing');
  const previous = await external.latest(id);
  const check = inspectSnapshot(snapshot, previous);
  if (check.status === 'TAMPERED') throw new Error('Demonstration history is inconsistent; preserved without repair');
  const head = snapshot.events.at(-1); if (!head) throw new Error('Demonstration audit missing');
  if (check.status !== 'VERIFIED') await external.publish({ auctionId: id, sequence: String(head.sequence), hash: head.eventHash }, previous);
}

/** Additive v3 scenarios. Existing/legacy data, credentials and auction terms are never reset. */
export async function seedDemonstration(db: Database, options: DemoSeedOptions = {}) {
  if (options.waitForSettlement && !options.external) throw new Error('Waiting for settlement requires an independent witness');
  const people = await db.select().from(users).where(inArray(users.email, ['auctioneer@verzel.local', 'bidder1@verzel.local', 'bidder2@verzel.local']));
  const owner = people.find(user => user.email === 'auctioneer@verzel.local');
  const bidders = ['bidder1@verzel.local', 'bidder2@verzel.local'].map(email => people.find(user => user.email === email));
  const [first, second] = bidders;
  if (owner?.role !== 'AUCTIONEER' || first?.role !== 'BIDDER' || second?.role !== 'BIDDER') throw new Error('Run the foundational seed first');
  await fundPristineWallets(db, [first.id, second.id]);
  const service = new AuctionService(new DrizzleAuctionRepository(db, tx => new DrizzleAuditAppender(tx)));
  const bidding = new BidService(new DrizzleBidRepository(db, new DrizzleReservationOperations(), tx => new DrizzleAuditAppender(tx)), new DrizzleBidQueryRepository(db));
  const results = [];
  for (const [index, scenario] of scenarios.entries()) {
    let auction = await ensureAuction(db, owner.id, scenario, index);
    let notice: string | undefined;
    if (scenario === 'cancelled' && auction.status === 'PUBLISHED') {
      try { auction = await service.cancel(auction.id, owner.id); }
      catch (error) {
        if (!(error instanceof AppError) || !['AUCTION_NOT_PUBLISHED', 'AUCTION_HAS_BIDS', 'AUCTION_EXPIRED'].includes(error.code)) throw error;
        notice = (await service.get(auction.id)).status === 'CANCELLED' ? undefined : 'EXISTING_AUCTION_PRESERVED';
      }
    } else if (scenario !== 'scheduled' && scenario !== 'cancelled' && auction.status === 'PUBLISHED') {
      if (+auction.startsAt - +(await clock(db)) > 5000) {
        results.push({ scenario, id: auction.id, lifecycleState: auction.lifecycleState, notice: 'EXISTING_AUCTION_PRESERVED' });
        continue;
      }
      await waitUntil(db, auction.startsAt);
      if (scenario === 'live-bids' || scenario === 'settled') {
        if (!auction.currentBidId && +(await clock(db)) < +auction.endsAt) {
          try { await bidding.placeBid(scenario === 'settled' ? second.id : first.id, auction.id, 5000n, 'demo-scenario-v3'); }
          catch (error) {
            if (!(error instanceof AppError) || !['INSUFFICIENT_FUNDS', 'ALREADY_LEADING', 'BID_TOO_LOW'].includes(error.code)) throw error;
            notice = error.code;
          }
        }
      }
      if (scenario === 'closed-no-bids' || (scenario === 'settled' && options.waitForSettlement)) {
        auction = await service.get(auction.id);
        const remaining = +auction.endsAt - +(await clock(db));
        if (remaining <= (scenario === 'closed-no-bids' ? 1500 : 180000)) await waitUntil(db, auction.endsAt);
        else notice = 'EXISTING_AUCTION_PRESERVED';
      }
    }
    auction = await service.get(auction.id);
    if (options.external) {
      try {
        await publishDemoHead(db, auction.id, options.external);
        if (auction.lifecycleState === 'FINALIZING' && (scenario !== 'settled' || auction.currentBidId)) {
          await new SettlementService(new DrizzleSettlementRepository(db), new DrizzleSettlementAuditGate(db, options.external)).settle(auction.id);
          await publishDemoHead(db, auction.id, options.external);
        }
      } catch { notice = 'WITNESS_OR_SETTLEMENT_PENDING'; }
    } else if (scenario === 'closed-no-bids' || scenario === 'settled') notice ??= 'INDEPENDENT_WITNESS_REQUIRED';
    auction = await service.get(auction.id);
    results.push({ scenario, id: auction.id, lifecycleState: auction.lifecycleState, ...(notice ? { notice } : {}) });
  }
  return results;
}
