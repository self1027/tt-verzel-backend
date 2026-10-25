import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { auctionSettlements } from '../../auctions/infrastructure/settlements.schema.js';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../../ledger/infrastructure/schema.js';
import { walletReservations, wallets } from '../../wallets/infrastructure/schema.js';
import type { ReceiptRecords, ReceiptRepository } from '../contracts/receipt.js';
import { readSettlementProof } from '../infrastructure/settlement-proof.js';
import { checkChain } from '../../audit/domain/cryptography.js';
import { checkOperational } from '../../audit/services/operational-integrity.js';
import { AppError } from '../../../shared/http/app-error.js';
import { auditEvents } from '../../audit/infrastructure/schema.js';
import { auditSelection, selectedAuditEvent, MAX_AUDIT_EVENTS } from '../../audit/repositories/audit-record.js';
import { AuditCorruptionError } from '../../audit/contracts/errors.js';
import { RecoveryService } from '../../auctions/services/recovery-service.js';

export class DrizzleReceiptRepository implements ReceiptRepository {
  constructor(private readonly db: Database) {}

  async find(auctionId: string): Promise<ReceiptRecords | null> {
    try { return await this.read(auctionId); }
    catch (error) {
      // Persist detection only after the read-only snapshot has ended, without financial locks across reads.
      if (error instanceof AuditCorruptionError) {
        await new RecoveryService(this.db).detect(auctionId, { status: 'TAMPERED', reason: 'RECEIPT_AUDIT_CORRUPT',
          verificationEvidence: typeof error.cause === 'string' ? error.cause : undefined });
        throw new AppError(409, 'RECEIPT_INCONSISTENT', 'Receipt financial records are inconsistent');
      }
      throw error;
    }
  }

  private read(auctionId: string): Promise<ReceiptRecords | null> {
    return this.db.transaction(async tx => {
      const [auction] = await tx.select().from(auctions).where(eq(auctions.id, auctionId));
      if (!auction || auction.status !== 'SETTLED') return null;
      const [settlement] = await tx.select({ id: auctionSettlements.id, auctionId: auctionSettlements.auctionId,
        winningBidId: auctionSettlements.winningBidId, ledgerTransactionId: auctionSettlements.ledgerTransactionId,
        amountCents: auctionSettlements.amountCents, settledAt: auctionSettlements.settledAt,
      }).from(auctionSettlements).where(eq(auctionSettlements.auctionId, auctionId));
      if (!settlement) return null;
      const [product] = await tx.select({ id: productSnapshots.id, title: productSnapshots.title, description: productSnapshots.description,
        imageUrl: productSnapshots.imageUrl, capturedAt: productSnapshots.capturedAt,
      }).from(productSnapshots).where(eq(productSnapshots.id, auction.productSnapshotId));
      const [bid] = await tx.select().from(bids).where(eq(bids.id, settlement.winningBidId));
      const [reservation] = await tx.select({ id: walletReservations.id, auctionId: walletReservations.auctionId,
        bidId: walletReservations.bidId, amountCents: walletReservations.amountCents, status: walletReservations.status, userId: wallets.userId,
      }).from(walletReservations).innerJoin(wallets, eq(wallets.id, walletReservations.walletId)).where(eq(walletReservations.bidId, settlement.winningBidId));
      const [transaction] = await tx.select({ type: ledgerTransactions.type, referenceId: ledgerTransactions.referenceId })
        .from(ledgerTransactions).where(eq(ledgerTransactions.id, settlement.ledgerTransactionId));
      const entries = await tx.select({ type: ledgerAccounts.type, userId: wallets.userId, amountCents: ledgerEntries.amountCents })
        .from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
        .leftJoin(wallets, eq(wallets.id, ledgerAccounts.walletId)).where(eq(ledgerEntries.transactionId, settlement.ledgerTransactionId));
      let evidence: unknown;
      try {
        const rows = await tx.select(auditSelection).from(auditEvents).where(eq(auditEvents.auctionId, auctionId))
          .orderBy(asc(auditEvents.sequence)).limit(MAX_AUDIT_EVENTS + 1);
        evidence = { rows, auction, settlement, product, bid, reservation, transaction, entries };
        if (!rows.length || rows.length > MAX_AUDIT_EVENTS) throw new Error('Receipt audit history missing or oversized');
        const events = rows.map(selectedAuditEvent);
        if (!checkChain(auctionId, events).valid) throw new AuditCorruptionError('Receipt audit chain is invalid');
        const version = events[0]?.hashVersion;
        const state = version === 2 ? await readSettlementProof(tx, auctionId) : null;
        if (state) evidence = { receipt: evidence, snapshot: state.snapshot };
        const integrityConsistent = !state || (checkChain(auctionId, state.snapshot.events).valid && checkOperational(state.snapshot).consistent);
        if (!integrityConsistent) throw new AuditCorruptionError('Receipt operational commitment diverges');
        return { auction, settlement, product: product ?? null, bid: bid ?? null, reservation: reservation ?? null, transaction: transaction ?? null, entries,
          integrityCoverage: version === 2 ? 'SELLER_PRODUCT_V2' : version === 1 ? 'LEGACY_V1' : 'UNAVAILABLE',
          integrityConsistent };
      } catch (error) {
        if (error instanceof AuditCorruptionError) throw new AuditCorruptionError(error.message,
          { cause: JSON.stringify(evidence, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value) });
        throw new AppError(409, 'RECEIPT_INCONSISTENT', 'Receipt financial records are inconsistent');
      }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
