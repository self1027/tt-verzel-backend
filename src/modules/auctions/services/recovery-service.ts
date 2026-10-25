import { createHash } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../../shared/events/auction-events.js';
import { walletReservations } from '../../wallets/infrastructure/schema.js';
import { DrizzleReservationOperations, lockReservationWallets } from '../../wallets/repositories/drizzle-reservation-operations.js';
import { auctionSettlements } from '../infrastructure/settlements.schema.js';
import { auctions } from '../infrastructure/schema.js';
import { auctionRecoveries } from '../infrastructure/recovery.schema.js';

const databaseTime = sql`date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')`;
type Detection = { status: string; reason?: string | null; verificationEvidence?: string | undefined };

export class RecoveryService {
  constructor(private readonly db: Database, private readonly events: AuctionEventSink = silentAuctionEvents) {}

  async detect(id: string, detection: Detection): Promise<void> {
    if (detection.status !== 'TAMPERED') return;
    // Commit the quarantine before any financial attempt: rollback cannot reopen bidding.
    await this.db.transaction(async tx => {
      const [auction] = await tx.select({ id: auctions.id }).from(auctions).where(eq(auctions.id, id)).for('update');
      if (!auction) return;
      const [existing] = await tx.select().from(auctionRecoveries).where(eq(auctionRecoveries.auctionId, id));
      if (existing) return;
      // Keep exact PostgreSQL JSON text, including BIGINT and sub-millisecond timestamps.
      const snapshot = await tx.execute<{ evidence: string }>(sql`SELECT jsonb_build_object(
        'auction', (SELECT to_jsonb(a) FROM auctions a WHERE a.id=${id}),
        'product', (SELECT to_jsonb(p) FROM product_snapshots p JOIN auctions a ON a.product_snapshot_id=p.id WHERE a.id=${id}),
        'events', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.sequence), '[]') FROM audit_events e WHERE e.auction_id=${id}),
        'bids', (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.sequence), '[]') FROM bids b WHERE b.auction_id=${id}),
        'reservations', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM wallet_reservations r WHERE r.auction_id=${id}),
        'settlement', (SELECT to_jsonb(s) FROM auction_settlements s WHERE s.auction_id=${id})
      )::text AS evidence`);
      const evidence = JSON.stringify({ detection, databaseSnapshot: snapshot.rows[0]?.evidence });
      const clock = await tx.execute<{ at: string }>(sql`SELECT to_char(${databaseTime}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
      const at = clock.rows[0]?.at;
      if (!at) throw new Error('Database clock unavailable');
      const detectedAt = new Date(at);
      await tx.insert(auctionRecoveries).values({ auctionId: id, reason: detection.reason ?? 'AUDIT_TAMPERED', evidence,
        evidenceHash: createHash('sha256').update(evidence).digest('hex'), detectedAt,
        targetAt: new Date(+detectedAt + 180000), nextAttemptAt: detectedAt });
    });
    try { this.events.publish({ type: 'auction:integrity-warning', auctionId: id, data: { reason: 'AUDIT_TAMPERED' } }); } catch { /* REST remains authoritative. */ }
    await this.process(id);
  }

  async process(id: string): Promise<void> {
    try {
      const changed = await this.db.transaction(async tx => {
        const [auction] = await tx.select().from(auctions).where(eq(auctions.id, id)).for('update');
        const [incident] = await tx.select().from(auctionRecoveries).where(eq(auctionRecoveries.auctionId, id)).for('update');
        if (!auction || incident?.state !== 'PENDING') return false;
        const reservations = await tx.select().from(walletReservations).where(eq(walletReservations.auctionId, id));
        await lockReservationWallets(tx, reservations.filter(r => r.status === 'ACTIVE').map(r => r.walletId));
        const operations = new DrizzleReservationOperations();
        let released = 0n;
        for (const reservation of reservations.filter(r => r.status === 'ACTIVE')) {
          const result = await operations.releaseReservation(tx, reservation.id);
          if (result.status !== 'RELEASED') throw new Error('Release not confirmed');
          released += result.amountCents;
        }
        const [active] = await tx.select({ id: walletReservations.id }).from(walletReservations)
          .where(and(eq(walletReservations.auctionId, id), eq(walletReservations.status, 'ACTIVE')));
        if (active) throw new Error('Active reservations remain');
        const captured = reservations.filter(r => r.status === 'CAPTURED').reduce((total, r) => total + r.amountCents, 0n);
        const [settlement] = await tx.select().from(auctionSettlements).where(eq(auctionSettlements.auctionId, id));
        const compensation = captured > 0n || auction.status === 'SETTLED' || Boolean(settlement);
        if (!compensation) await tx.update(auctions).set({ status: 'CANCELLED', updatedAt: databaseTime }).where(eq(auctions.id, id));
        await tx.update(auctionRecoveries).set({ state: compensation ? 'COMPENSATION_REQUIRED' : 'RELEASED',
          attempts: incident.attempts + 1, releasedCents: released, capturedCents: captured,
          completedAt: databaseTime, lastError: null }).where(eq(auctionRecoveries.auctionId, id));
        return !compensation;
      });
      if (changed) { try { this.events.publish({ type: 'auction:cancelled', auctionId: id, data: { reason: 'AUDIT_TAMPERED' } }); } catch { /* Best effort. */ } }
    } catch (error) {
      // Independent transaction: failure/retry survives both process restart and financial rollback.
      await this.db.update(auctionRecoveries).set({ attempts: sql`${auctionRecoveries.attempts} + 1`,
        lastError: error instanceof AppError ? error.code : 'RECOVERY_FAILED',
        nextAttemptAt: sql`${databaseTime} + interval '5 seconds'` })
        .where(and(eq(auctionRecoveries.auctionId, id), eq(auctionRecoveries.state, 'PENDING')));
    }
  }

  async runOnce(): Promise<void> {
    const pending = await this.db.select({ id: auctionRecoveries.auctionId }).from(auctionRecoveries)
      .where(and(eq(auctionRecoveries.state, 'PENDING'), lte(auctionRecoveries.nextAttemptAt, databaseTime)))
      .orderBy(asc(auctionRecoveries.nextAttemptAt), asc(auctionRecoveries.auctionId)).limit(20);
    for (const incident of pending) await this.process(incident.id);
  }
}
