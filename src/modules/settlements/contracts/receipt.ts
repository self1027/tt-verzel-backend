import type { Auction } from '../../auctions/contracts/auctions.js';
import type { Bid } from '../../bids/contracts/bids.js';
import type { ProductSnapshot } from '../../catalog/contracts/catalog.js';
import type { Settlement } from './settlements.js';

export type ReceiptProduct = Pick<ProductSnapshot, 'id' | 'title' | 'description' | 'imageUrl' | 'capturedAt'>;
export interface ReceiptRecords {
  auction: Auction;
  settlement: Omit<Settlement, 'receiptToken'>;
  product: ReceiptProduct | null;
  bid: Bid | null;
  reservation: { id: string; auctionId: string; bidId: string; amountCents: bigint; status: string; userId: string } | null;
  transaction: { type: string; referenceId: string | null } | null;
  entries: { type: string; userId: string | null; amountCents: bigint }[];
}
export interface ReceiptRepository { find(auctionId: string): Promise<ReceiptRecords | null> }
export interface PublicReceipt {
  auctionId: string;
  productSnapshot: Omit<ReceiptProduct, 'capturedAt'> & { capturedAt: string };
  amountCents: string;
  endsAt: string;
  settledAt: string;
  settlementId: string;
  winningBid: { id: string; bidderRef: string };
  auditUrl: string;
  receiptUrl: string;
}
export interface ReceiptUseCases { get(auctionId: string): Promise<PublicReceipt> }
