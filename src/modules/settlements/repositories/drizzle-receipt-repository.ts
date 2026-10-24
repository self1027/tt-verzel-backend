import { eq } from 'drizzle-orm';
import type { Database } from '../../../shared/database/client.js';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { auctionSettlements } from '../../auctions/infrastructure/settlements.schema.js';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../../ledger/infrastructure/schema.js';
import { walletReservations, wallets } from '../../wallets/infrastructure/schema.js';
import type { ReceiptRecords, ReceiptRepository } from '../contracts/receipt.js';

export class DrizzleReceiptRepository implements ReceiptRepository {
  constructor(private readonly db: Database) {}

  find(auctionId: string): Promise<ReceiptRecords | null> {
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
      return { auction, settlement, product: product ?? null, bid: bid ?? null, reservation: reservation ?? null, transaction: transaction ?? null, entries };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
