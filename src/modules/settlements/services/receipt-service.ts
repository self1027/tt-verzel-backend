import { AppError } from '../../../shared/http/app-error.js';
import { bidderReference } from '../../audit/domain/cryptography.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';
import type { PublicReceipt, ReceiptRepository, ReceiptUseCases } from '../contracts/receipt.js';

export class ReceiptService implements ReceiptUseCases {
  constructor(private readonly repository: ReceiptRepository) {}

  async get(auctionId: string): Promise<PublicReceipt> {
    const records = await this.repository.find(auctionId);
    if (!records || records.auction.status !== 'SETTLED') throw new AppError(404, 'RECEIPT_NOT_AVAILABLE', 'Receipt is not available');
    const { auction, settlement, product, bid, reservation, transaction, entries } = records;
    if (!product || !bid || !reservation || !transaction
      || auction.id !== auctionId || product.id !== auction.productSnapshotId || settlement.auctionId !== auctionId
      || auction.currentBidId !== bid.id || bid.id !== settlement.winningBidId || bid.auctionId !== auctionId
      || settlement.amountCents <= 0n || settlement.amountCents > MAX_CENTS || bid.amountCents !== settlement.amountCents
      || reservation.auctionId !== auctionId || reservation.bidId !== bid.id || reservation.userId !== bid.bidderId
      || reservation.status !== 'CAPTURED' || reservation.amountCents !== settlement.amountCents
      || transaction.type !== 'AUCTION_SETTLEMENT' || transaction.referenceId !== reservation.id
      || bid.bidderId === auction.auctioneerId || entries.length !== 2
      || entries.filter(entry => entry.type === 'USER_WALLET' && entry.userId === bid.bidderId && entry.amountCents === -settlement.amountCents).length !== 1
      || entries.filter(entry => entry.type === 'USER_WALLET' && entry.userId === auction.auctioneerId && entry.amountCents === settlement.amountCents).length !== 1
      || !Number.isFinite(+auction.endsAt) || !Number.isFinite(+settlement.settledAt) || !Number.isFinite(+product.capturedAt)
      || settlement.settledAt < auction.endsAt) {
      throw new AppError(409, 'RECEIPT_INCONSISTENT', 'Receipt financial records are inconsistent');
    }
    return {
      auctionId, productSnapshot: { id: product.id, title: product.title, description: product.description,
        imageUrl: product.imageUrl, capturedAt: product.capturedAt.toISOString() },
      amountCents: settlement.amountCents.toString(), endsAt: auction.endsAt.toISOString(), settledAt: settlement.settledAt.toISOString(),
      settlementId: settlement.id, winningBid: { id: bid.id, bidderRef: bidderReference(auctionId, bid.bidderId) },
      auditUrl: `/auctions/${auctionId}/audit`, receiptUrl: `/auctions/${auctionId}/receipt`,
    };
  }
}
