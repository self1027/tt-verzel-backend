import { assertAuctionNotBlocked } from '../infrastructure/recovery-guard.js';
import { DrizzleReservationOperations, lockReservationWallets } from '../../wallets/repositories/drizzle-reservation-operations.js';
import { and, asc, count, desc, eq, gt, gte, ilike, lte, ne, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../../shared/database/client.js';
import type { AuditAppender } from '../../audit/contracts/audit.js';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';
import { auctions, bids } from '../infrastructure/schema.js';
import type { AuctionPage, AuctionQuery, AuctionRepository, AuctionWithSnapshot, AuctionWriteContext } from '../contracts/auctions.js';
import { walletReservations } from '../../wallets/infrastructure/schema.js';
import { AppError } from '../../../shared/http/app-error.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../../shared/events/auction-events.js';
import { auctionRecoveries } from '../infrastructure/recovery.schema.js';

async function databaseNow(db: Pick<Database, 'execute'>): Promise<Date> {
  const result = await db.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
  const value = result.rows[0]?.now;
  if (!value) throw new Error('Database clock returned no value');
  return new Date(value);
}

const joinedSelection = { auction: auctions, productSnapshot: productSnapshots, incident: auctionRecoveries,
  sellerCancelled: sql<boolean>`EXISTS (SELECT 1 FROM audit_events e WHERE e.auction_id = ${auctions.id}
    AND e.event_type = 'AUCTION_CANCELLED' AND e.payload->>'reason' = 'SELLER_REQUEST')`,
  remaining: sql<string>`(SELECT coalesce(sum(${walletReservations.amountCents}), 0)::text FROM ${walletReservations}
    WHERE ${walletReservations.auctionId} = ${auctions.id} AND ${walletReservations.status} = 'ACTIVE')` };

function joinedView(row: { auction: typeof auctions.$inferSelect; productSnapshot: typeof productSnapshots.$inferSelect;
  incident: typeof auctionRecoveries.$inferSelect | null; remaining: string; sellerCancelled: boolean }): AuctionWithSnapshot {
  const incident = row.incident;
  return { ...row.auction, productSnapshot: row.productSnapshot,
    cancellationReason: row.auction.status === 'CANCELLED' ? (incident ? 'AUDIT_TAMPERED' : row.sellerCancelled ? 'SELLER_REQUEST' : null) : null,
    recovery: incident ? { reason: incident.reason, state: incident.state,
      detectedAt: incident.detectedAt.toISOString(), targetAt: incident.targetAt.toISOString(),
      completedAt: incident.completedAt?.toISOString() ?? null, attempts: incident.attempts, lastError: incident.lastError,
      remainingReservedCents: row.remaining, releasedCents: String(incident.releasedCents), capturedCents: String(incident.capturedCents) } : null };
}

async function findJoined(db: Pick<Database, 'select'>, id: string): Promise<AuctionWithSnapshot | null> {
  const [row] = await db.select(joinedSelection).from(auctions)
    .innerJoin(productSnapshots, eq(auctions.productSnapshotId, productSnapshots.id))
    .leftJoin(auctionRecoveries, eq(auctionRecoveries.auctionId, auctions.id)).where(eq(auctions.id, id)).limit(1);
  return row ? joinedView(row) : null;
}

const currentPrice = sql`coalesce(${bids.amountCents}, ${auctions.startingBidCents})`;
const currentBid = and(eq(bids.id, auctions.currentBidId), eq(bids.auctionId, auctions.id));

function filters(input: AuctionQuery, now: Date) {
  const owner = input.auctioneerId ? eq(auctions.auctioneerId, input.auctioneerId) : undefined;
  const title = input.q === undefined ? undefined : ilike(productSnapshots.title, `%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
  const common = and(owner, input.auctioneerId ? undefined : ne(auctions.status, 'CANCELLED'),
    input.auctioneerId ? undefined : sql`NOT EXISTS (SELECT 1 FROM ${auctionRecoveries} WHERE ${auctionRecoveries.auctionId} = ${auctions.id})`, title,
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
          if (auction) await assertAuctionNotBlocked(tx, id);
          return auction ?? null;
        },
        databaseNow: () => databaseNow(tx),
        async snapshotExists(id) {
          const [snapshot] = await tx.select({ id: productSnapshots.id }).from(productSnapshots)
            .where(eq(productSnapshots.id, id)).for('share');
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
            const reservations = await tx.select().from(walletReservations).where(eq(walletReservations.auctionId, id));
            if (reservations.some(r => r.status === 'CAPTURED')) throw new AppError(409, 'RESERVATION_CONFLICT', 'Captured funds require specific compensation');
            const active = reservations.filter(r => r.status === 'ACTIVE');
            await lockReservationWallets(tx, active.map(r => r.walletId));
            for (const reservation of active) await new DrizzleReservationOperations().releaseReservation(tx, reservation.id);
          }
          await tx.update(auctions).set(changes).where(eq(auctions.id, id));
          const result = await requiredJoined(id);
          await record(result, changes.status === 'CANCELLED' ? 'AUCTION_CANCELLED' : 'AUCTION_UPDATED');
          if (changes.status === 'CANCELLED') {
            cancelled = id;
            return requiredJoined(id);
          }
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
      const rows = await tx.select(joinedSelection).from(auctions)
        .innerJoin(productSnapshots, eq(auctions.productSnapshotId, productSnapshots.id)).leftJoin(bids, currentBid).leftJoin(auctionRecoveries, eq(auctionRecoveries.auctionId, auctions.id)).where(where)
        .orderBy(...ordering(input)).limit(input.limit).offset(input.skip);
      const [total] = await tx.select({ value: count() }).from(auctions)
        .innerJoin(productSnapshots, eq(auctions.productSnapshotId, productSnapshots.id)).leftJoin(bids, currentBid).where(where);
      return { auctions: rows.map(joinedView),
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
