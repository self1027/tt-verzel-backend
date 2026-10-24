import { and, asc, count, desc, eq, gt, gte, ilike, lte, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../../shared/database/client.js';
import type { AuditAppender } from '../../audit/contracts/audit.js';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';
import { auctions, bids } from '../infrastructure/schema.js';
import type { AuctionPage, AuctionQuery, AuctionRepository, AuctionWithSnapshot, AuctionWriteContext } from '../contracts/auctions.js';
import { walletReservations } from '../../wallets/infrastructure/schema.js';
import { AppError } from '../../../shared/http/app-error.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../../shared/events/auction-events.js';

async function databaseNow(db: Pick<Database, 'execute'>): Promise<Date> {
  const result = await db.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
  const value = result.rows[0]?.now;
  if (!value) throw new Error('Database clock returned no value');
  return new Date(value);
}

async function findJoined(db: Pick<Database, 'select'>, id: string): Promise<AuctionWithSnapshot | null> {
  const [row] = await db.select({ auction: auctions, productSnapshot: productSnapshots }).from(auctions)
    .innerJoin(productSnapshots, eq(auctions.productSnapshotId, productSnapshots.id)).where(eq(auctions.id, id)).limit(1);
  return row ? { ...row.auction, productSnapshot: row.productSnapshot } : null;
}

const currentPrice = sql`coalesce(${bids.amountCents}, ${auctions.startingBidCents})`;
const currentBid = and(eq(bids.id, auctions.currentBidId), eq(bids.auctionId, auctions.id));

function filters(input: AuctionQuery, now: Date) {
  const owner = input.auctioneerId ? eq(auctions.auctioneerId, input.auctioneerId) : undefined;
  const title = input.q === undefined ? undefined : ilike(productSnapshots.title, `%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
  const common = and(owner, title,
    input.minPriceCents === undefined ? undefined : gte(currentPrice, input.minPriceCents.toString()),
    input.maxPriceCents === undefined ? undefined : lte(currentPrice, input.maxPriceCents.toString()));
  const published = eq(auctions.status, 'PUBLISHED');
  switch (input.lifecycleState) {
    case 'SCHEDULED': return and(common, published, gt(auctions.startsAt, now));
    case 'LIVE': return and(common, published, lte(auctions.startsAt, now), gt(auctions.endsAt, now));
    case 'FINALIZING': return and(common, published, lte(auctions.startsAt, now), lte(auctions.endsAt, now));
    case 'CANCELLED': case 'SETTLED': case 'CLOSED_NO_BIDS':
      return and(common, eq(auctions.status, input.lifecycleState));
    default: return common;
  }
}

function ordering(input: AuctionQuery) {
  switch (input.sort) {
    case 'price_asc': return [asc(currentPrice), asc(auctions.id)];
    case 'price_desc': return [desc(currentPrice), asc(auctions.id)];
    case 'endsAt_asc': return [asc(auctions.endsAt), asc(auctions.id)];
    case 'endsAt_desc': return [desc(auctions.endsAt), asc(auctions.id)];
    default: return [desc(auctions.createdAt), asc(auctions.id)];
  }
}

export class DrizzleAuctionRepository implements AuctionRepository {
  constructor(private readonly db: Database, private readonly audit?: (tx: DatabaseTransaction) => AuditAppender,
    private readonly events: AuctionEventSink = silentAuctionEvents) {}

  transaction<T>(work: (tx: AuctionWriteContext) => Promise<T>): Promise<T> {
    let cancelled: string | undefined;
    return this.db.transaction(async (tx) => {
      async function requiredJoined(id: string): Promise<AuctionWithSnapshot> {
        const result = await findJoined(tx, id);
        if (!result) throw new Error('Auction write returned no record');
        return result;
      }
      const audit = this.audit?.(tx);
      async function record(auction: AuctionWithSnapshot, eventType: 'AUCTION_CREATED' | 'AUCTION_UPDATED' | 'AUCTION_CANCELLED'): Promise<void> {
        if (!audit) return;
        await audit.append({ auctionId: auction.id, eventType, createdAt: auction.updatedAt.toISOString(), payload: {
          productSnapshotId: auction.productSnapshotId, startingBidCents: auction.startingBidCents.toString(),
          minIncrementCents: auction.minIncrementCents.toString(), startsAt: auction.startsAt.toISOString(), endsAt: auction.endsAt.toISOString(),
          status: auction.status, currentBidId: auction.currentBidId,
          ...(eventType === 'AUCTION_CANCELLED' ? { reason: 'SELLER_REQUEST' } : {}),
        } });
      }
      return work({
        async lock(id) {
          const [auction] = await tx.select().from(auctions).where(eq(auctions.id, id)).for('update');
          return auction ?? null;
        },
        databaseNow: () => databaseNow(tx),
        async snapshotExists(id) {
          const [snapshot] = await tx.select({ id: productSnapshots.id }).from(productSnapshots)
            .where(eq(productSnapshots.id, id)).for('key share');
          return snapshot !== undefined;
        },
        async hasBids(id) {
          const [bid] = await tx.select({ id: bids.id }).from(bids).where(eq(bids.auctionId, id)).limit(1);
          return bid !== undefined;
        },
        async insert(auction) {
          await tx.insert(auctions).values(auction);
          const result = await requiredJoined(auction.id);
          await record(result, 'AUCTION_CREATED');
          return result;
        },
        async update(id, changes) {
          if (changes.status === 'CANCELLED') {
            const [reservation] = await tx.select({ id: walletReservations.id }).from(walletReservations)
              .where(and(eq(walletReservations.auctionId, id), eq(walletReservations.status, 'ACTIVE'))).limit(1);
            if (reservation) throw new AppError(409, 'RESERVATION_CONFLICT', 'Cannot cancel inconsistent financial state');
          }
          await tx.update(auctions).set(changes).where(eq(auctions.id, id));
          const result = await requiredJoined(id);
          await record(result, changes.status === 'CANCELLED' ? 'AUCTION_CANCELLED' : 'AUCTION_UPDATED');
          if (changes.status === 'CANCELLED') cancelled = id;
          return result;
        },
      });
    }, { isolationLevel: 'read committed' }).then(result => {
      if (cancelled) { try { this.events.publish({ type: 'auction:cancelled', auctionId: cancelled, data: { reason: 'SELLER_REQUEST' } }); } catch { /* Best effort. */ } }
      return result;
    });
  }

  list(input: AuctionQuery): Promise<AuctionPage<AuctionWithSnapshot>> {
    return this.db.transaction(async (tx) => {
      const asOf = await databaseNow(tx);
      const where = filters(input, asOf);
      const rows = await tx.select({ auction: auctions, productSnapshot: productSnapshots }).from(auctions)
        .innerJoin(productSnapshots, eq(auctions.productSnapshotId, productSnapshots.id)).leftJoin(bids, currentBid).where(where)
        .orderBy(...ordering(input)).limit(input.limit).offset(input.skip);
      const [total] = await tx.select({ value: count() }).from(auctions)
        .innerJoin(productSnapshots, eq(auctions.productSnapshotId, productSnapshots.id)).leftJoin(bids, currentBid).where(where);
      return { auctions: rows.map((row) => ({ ...row.auction, productSnapshot: row.productSnapshot })),
        total: total?.value ?? 0, limit: input.limit, skip: input.skip, asOf };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  findById(id: string): Promise<{ auction: AuctionWithSnapshot | null; asOf: Date }> {
    return this.db.transaction(async (tx) => {
      const asOf = await databaseNow(tx);
      return { auction: await findJoined(tx, id), asOf };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
