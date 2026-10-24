import { asc, count, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { bidderReference } from '../../audit/domain/cryptography.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';
import type { Bid, BidPagination, BidQueryRepository, OwnBidPage, PublicBid, PublicBidPage } from '../contracts/bids.js';
import { validateHistory } from '../domain/bid-rules.js';

const corrupt = (): AppError => new AppError(409, 'BID_HISTORY_CORRUPT', 'Bid history or current pointer is inconsistent');

async function databaseNow(db: Pick<Database, 'execute'>): Promise<string> {
  const result = await db.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
  const now = result.rows[0]?.now;
  if (!now || !Number.isFinite(Date.parse(now))) throw new Error('Database clock returned no valid value');
  return now;
}

function present(bid: Bid): PublicBid {
  if (bid.amountCents <= 0n || bid.amountCents > MAX_CENTS || bid.sequence <= 0n || bid.sequence > MAX_CENTS
    || !Number.isFinite(+bid.createdAt)) throw corrupt();
  return { id: bid.id, auctionId: bid.auctionId, bidderRef: bidderReference(bid.auctionId, bid.bidderId),
    amountCents: bid.amountCents.toString(), sequence: bid.sequence.toString(), createdAt: bid.createdAt.toISOString() };
}

function deadline(endsAt: Date): string {
  if (!Number.isFinite(+endsAt)) throw corrupt();
  return endsAt.toISOString();
}

export class DrizzleBidQueryRepository implements BidQueryRepository {
  constructor(private readonly db: Database) {}

  history(auctionId: string, query: BidPagination): Promise<PublicBidPage> {
    return this.db.transaction(async (tx) => {
      const asOf = await databaseNow(tx);
      const [auction] = await tx.select().from(auctions).where(eq(auctions.id, auctionId)).limit(1);
      if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
      const where = eq(bids.auctionId, auctionId);
      // Validate the bounded complete history, including rows outside the public page.
      const history = await tx.select().from(bids).where(where).orderBy(asc(bids.sequence)).limit(10001);
      if (history.length > 10000) throw corrupt();
      const latest = validateHistory(auction, history);
      const length = history.length;
      const rows = await tx.select().from(bids).where(where).orderBy(asc(bids.sequence)).limit(query.limit).offset(query.skip);
      return { bids: rows.map(present), total: length, ...query, currentBid: latest ? present(latest) : null,
        endsAt: deadline(auction.endsAt), status: auction.status, asOf };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  mine(userId: string, query: BidPagination): Promise<OwnBidPage> {
    return this.db.transaction(async (tx) => {
      const asOf = await databaseNow(tx);
      const where = eq(bids.bidderId, userId);
      const rows = await tx.select({ bid: bids, auction: auctions }).from(bids)
        .innerJoin(auctions, eq(auctions.id, bids.auctionId)).where(where)
        .orderBy(desc(bids.createdAt), asc(bids.id)).limit(query.limit).offset(query.skip);
      const [total] = await tx.select({ value: count() }).from(bids).where(where);
      return { bids: rows.map(({ bid, auction }) => ({ ...present(bid), isLeading: auction.currentBidId === bid.id,
        status: auction.status, endsAt: deadline(auction.endsAt) })), total: total?.value ?? 0, ...query, asOf };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
