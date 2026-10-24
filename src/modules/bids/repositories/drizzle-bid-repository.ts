import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { users } from '../../users/infrastructure/schema.js';
import { wallets, walletReservations } from '../../wallets/infrastructure/schema.js';
import type { ReservationOperations } from '../../wallets/contracts/reservations.js';
import { lockReservationWallets } from '../../wallets/repositories/drizzle-reservation-operations.js';
import type { AuditAppender } from '../../audit/contracts/audit.js';
import type { BidRepository, BidWriteContext } from '../contracts/bids.js';
import { DrizzleBidOperationStore } from './drizzle-bid-operation-store.js';
import { appendAcceptedBid } from '../infrastructure/transactional-bid-audit.js';
import type { Bid } from '../contracts/bids.js';
import { bidderReference } from '../../audit/domain/cryptography.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../../shared/events/auction-events.js';

export class DrizzleBidRepository implements BidRepository {
  constructor(private readonly db: Database,
    private readonly reservations: Pick<ReservationOperations, 'reserveFunds' | 'releaseReservation'>,
    private readonly auditFactory: (tx: DatabaseTransaction) => AuditAppender, private readonly events: AuctionEventSink = silentAuctionEvents) {}

  transaction<T>(work: (tx: BidWriteContext) => Promise<T>): Promise<T> {
    let accepted: { bid: Bid; endsAt: Date } | undefined;
    let previousEndsAt: Date | undefined;
    return this.db.transaction((tx) => work({
      operations: new DrizzleBidOperationStore(tx),
      async lockAuction(id) {
        const [auction] = await tx.select().from(auctions).where(eq(auctions.id, id)).for('update');
        previousEndsAt = auction?.endsAt;
        return auction ?? null;
      },
      async actor(id) {
        const [user] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id));
        return user ?? null;
      },
      async databaseNow() {
        const result = await tx.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
        const at = result.rows[0]?.now;
        if (!at) throw new Error('Database clock unavailable');
        return new Date(at);
      },
      async history(auctionId) {
        const rows = await tx.select({ bid: bids, canonicalDate: sql<boolean>`${bids.createdAt} = date_trunc('milliseconds', ${bids.createdAt})` })
          .from(bids).where(eq(bids.auctionId, auctionId)).orderBy(asc(bids.sequence)).limit(10001);
        if (rows.length > 10000 || rows.some((row) => !row.canonicalDate)) throw new AppError(409, 'BID_HISTORY_CORRUPT', 'Unsupported or inconsistent bid history');
        return rows.map((row) => row.bid);
      },
      async lockWallets(userIds) {
        const required = [...new Set(userIds)];
        const found = await tx.select({ id: wallets.id, userId: wallets.userId }).from(wallets).where(inArray(wallets.userId, required));
        if (found.length !== required.length) throw new AppError(404, 'WALLET_NOT_FOUND', 'A required wallet is missing');
        return lockReservationWallets(tx, found.map((row) => row.id));
      },
      lockReservations: (auctionId) => tx.select().from(walletReservations)
        .where(and(eq(walletReservations.auctionId, auctionId), eq(walletReservations.status, 'ACTIVE'))).for('update'),
      releaseReservation: (id) => this.reservations.releaseReservation(tx, id),
      reserveFunds: (input) => this.reservations.reserveFunds(tx, input),
      async insertBid(bid) { await tx.insert(bids).values(bid); },
      async updateLeader(auctionId, bidId, endsAt, at) {
        await tx.update(auctions).set({ currentBidId: bidId, endsAt, updatedAt: at }).where(eq(auctions.id, auctionId));
      },
      appendAudit: async (bid, endsAt) => { await appendAcceptedBid(tx, bid, endsAt, this.auditFactory(tx)); accepted = { bid, endsAt }; },
    }), { isolationLevel: 'read committed' }).then(result => {
      if (accepted) {
        const { bid, endsAt } = accepted;
        try {
          this.events.publish({ type: 'bid:accepted', auctionId: bid.auctionId, data: { id: bid.id, bidderRef: bidderReference(bid.auctionId, bid.bidderId),
            amountCents: String(bid.amountCents), sequence: String(bid.sequence), createdAt: bid.createdAt.toISOString(), endsAt: endsAt.toISOString() } });
          if (previousEndsAt && +previousEndsAt !== +endsAt) this.events.publish({ type: 'auction:extended', auctionId: bid.auctionId, data: { endsAt: endsAt.toISOString() } });
        } catch { /* REST recovers missed best-effort notifications. */ }
      }
      return result;
    });
  }
}
