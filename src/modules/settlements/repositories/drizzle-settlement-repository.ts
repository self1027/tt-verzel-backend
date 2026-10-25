import { assertAuctionNotBlocked } from '../../auctions/infrastructure/recovery-guard.js';
import { auctionRecoveries } from '../../auctions/infrastructure/recovery.schema.js';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { auctionSettlements } from '../../auctions/infrastructure/settlements.schema.js';
import { wallets, walletReservations } from '../../wallets/infrastructure/schema.js';
import { DrizzleReservationOperations, lockReservationWallets } from '../../wallets/repositories/drizzle-reservation-operations.js';
import { DrizzleLedgerRepository } from '../../ledger/repositories/drizzle-ledger-repository.js';
import { DrizzleAuditAppender } from '../../audit/repositories/drizzle-audit-appender.js';
import { checkOperational } from '../../audit/services/operational-integrity.js';
import { canonicalJson, checkChain } from '../../audit/domain/cryptography.js';
import { readSettlementProof } from '../infrastructure/settlement-proof.js';
import type { SettlementContext, SettlementRepository } from '../contracts/settlements.js';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';

export class DrizzleSettlementRepository implements SettlementRepository {
  constructor(private readonly db: Database) {}

  async terminal(id: string) {
    const [incident] = await this.db.select().from(auctionRecoveries).where(eq(auctionRecoveries.auctionId, id));
    if (incident) return { auctionId: id, status: 'TAMPERED' as const, reason: incident.reason };
    const [auction] = await this.db.select().from(auctions).where(eq(auctions.id, id));
    if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
    if (auction.status === 'SETTLED') {
      const [settlement] = await this.db.select().from(auctionSettlements).where(eq(auctionSettlements.auctionId, id));
      if (!settlement || settlement.winningBidId !== auction.currentBidId) throw new AppError(409, 'SETTLEMENT_CONFLICT', 'Settlement record is inconsistent');
      return { auctionId: id, status: 'SETTLED' as const, settlementId: settlement.id };
    }
    if (auction.status === 'CLOSED_NO_BIDS') return { auctionId: id, status: 'CLOSED_NO_BIDS' as const };
    return auction.status !== 'PUBLISHED' ? { auctionId: id, status: 'UNCHANGED' as const } : null;
  }

  async due(limit: number, excluded: string[] = []) {
    const rows = await this.db.select({ id: auctions.id }).from(auctions).where(and(eq(auctions.status, 'PUBLISHED'),
      lte(auctions.endsAt, sql`clock_timestamp() AT TIME ZONE 'UTC'`), excluded.length ? notInArray(auctions.id, excluded) : undefined))
      .orderBy(asc(auctions.endsAt), asc(auctions.id)).limit(limit);
    return rows.map(row => row.id);
  }

  transaction<T>(work: (tx: SettlementContext) => Promise<T>): Promise<T> {
    return this.db.transaction(tx => {
      const reservations = new DrizzleReservationOperations();
      async function validateFinalAudit(id: string): Promise<void> {
        const state = await readSettlementProof(tx, id);
        if (!checkOperational(state.snapshot).consistent) throw new AppError(409, 'AUDIT_STATE_CONFLICT', 'Settlement audit is inconsistent');
      }
      return work({
        async lockAuction(id) {
          const [row] = await tx.select().from(auctions).where(eq(auctions.id, id)).for('update');
          if (row) await assertAuctionNotBlocked(tx, id);
          if (row) await tx.select({ id: productSnapshots.id }).from(productSnapshots).where(eq(productSnapshots.id, row.productSnapshotId)).for('share');
          return row ?? null;
        },
        async now() {
          const result = await tx.execute<{ at: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
          const at = result.rows[0]?.at; if (!at) throw new Error('Database clock unavailable'); return new Date(at);
        },
        async findSettlement(id) { const [row] = await tx.select().from(auctionSettlements).where(eq(auctionSettlements.auctionId, id)); return row ?? null; },
        async proofMatches(id, proof) {
          const current = await readSettlementProof(tx, id);
          const version = current.snapshot.events[0]?.hashVersion;
          const boundOrNoBids = version === 2 || (version === 1 && current.snapshot.operational.bids.length === 0);
          return boundOrNoBids && canonicalJson(current.proof) === canonicalJson(proof)
            && checkChain(id, current.snapshot.events).valid && checkOperational(current.snapshot).consistent;
        },
        history: id => tx.select().from(bids).where(eq(bids.auctionId, id)).orderBy(asc(bids.sequence)),
        async lockWallets(userIds) {
          const ids = [...new Set(userIds)];
          const rows = await tx.select({ id: wallets.id }).from(wallets).where(inArray(wallets.userId, ids));
          if (rows.length !== ids.length) throw new AppError(409, 'INVALID_WALLET_STATE', 'A settlement wallet is missing');
          return lockReservationWallets(tx, rows.map(row => row.id));
        },
        lockReservations: id => tx.select().from(walletReservations).where(and(eq(walletReservations.auctionId, id), eq(walletReservations.status, 'ACTIVE'))).for('update'),
        capture: (id, recipient, key) => reservations.captureReservation(tx, { reservationId: id, recipientWalletId: recipient, idempotencyKey: key }),
        ledger: key => new DrizzleLedgerRepository(tx).findByKey(key),
        async insert(settlement) { await tx.insert(auctionSettlements).values(settlement); },
        async finish(id, status, at) { await tx.update(auctions).set({ status, updatedAt: at }).where(eq(auctions.id, id)); },
        async auditSettlement(settlement) {
          await new DrizzleAuditAppender(tx).append({ auctionId: settlement.auctionId, eventType: 'AUCTION_SETTLED', createdAt: settlement.settledAt.toISOString(), payload: {
            settlementId: settlement.id, winningBidId: settlement.winningBidId, ledgerTransactionId: settlement.ledgerTransactionId,
            amountCents: String(settlement.amountCents), settledAt: settlement.settledAt.toISOString(),
            receiptHash: createHash('sha256').update(settlement.receiptToken).digest('hex'),
          } });
          await validateFinalAudit(settlement.auctionId);
        },
        async auditClosed(id, at) {
          await new DrizzleAuditAppender(tx).append({ auctionId: id, eventType: 'AUCTION_CLOSED_NO_BIDS', createdAt: at.toISOString(), payload: {} });
          await validateFinalAudit(id);
        },
      });
    }, { isolationLevel: 'read committed' });
  }
}
