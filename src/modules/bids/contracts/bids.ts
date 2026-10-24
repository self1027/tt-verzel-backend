import type { Reservation } from '../../wallets/contracts/reservations.js';
import type { AuctionStatus } from '../../auctions/contracts/auctions.js';

export interface BidAuction {
  id: string; status: AuctionStatus; currentBidId: string | null;
  startingBidCents: bigint; minIncrementCents: bigint; startsAt: Date; endsAt: Date;
}
export interface Bid {
  id: string; auctionId: string; bidderId: string;
  amountCents: bigint; sequence: bigint; createdAt: Date;
}
export interface PublicBid {
  id: string; auctionId: string; bidderRef: string;
  amountCents: string; sequence: string; createdAt: string;
}
/** Receipt is immutable: endsAt is the deadline resulting from THIS accepted bid. */
export interface BidReceipt extends PublicBid { endsAt: string }
export interface BidWallet { id: string; userId: string; balanceCents: bigint; reservedCents: bigint }
export interface BidPagination { limit: number; skip: number }
export interface PublicBidPage extends BidPagination {
  bids: PublicBid[]; total: number; currentBid: PublicBid | null;
  endsAt: string; status: AuctionStatus; asOf: string;
}
export interface OwnBidPage extends BidPagination {
  bids: (PublicBid & { isLeading: boolean; status: AuctionStatus; endsAt: string })[];
  total: number; asOf: string;
}
export interface StoredBidOperation { fingerprint: string; result: BidReceipt }
export interface NewBidOperation extends StoredBidOperation { userId: string; auctionId: string; key: string }
export interface BidOperationStore {
  find(userId: string, auctionId: string, key: string): Promise<StoredBidOperation | null>;
  save(operation: NewBidOperation): Promise<void>;
}
export interface BidWriteContext {
  lockAuction(id: string): Promise<BidAuction | null>;
  actor(id: string): Promise<{ id: string; role: 'BIDDER' | 'AUCTIONEER' } | null>;
  databaseNow(): Promise<Date>;
  history(auctionId: string): Promise<Bid[]>;
  operations: BidOperationStore;
  lockWallets(userIds: string[]): Promise<BidWallet[]>;
  lockReservations(auctionId: string): Promise<Reservation[]>;
  releaseReservation(id: string): Promise<Reservation>;
  reserveFunds(input: { walletId: string; auctionId: string; bidId: string; amountCents: bigint }): Promise<Reservation>;
  insertBid(bid: Bid): Promise<void>;
  updateLeader(auctionId: string, bidId: string, endsAt: Date, at: Date): Promise<void>;
  appendAudit(bid: Bid, endsAt: Date): Promise<void>;
}
export interface BidRepository { transaction<T>(work: (tx: BidWriteContext) => Promise<T>): Promise<T> }
export interface BidQueryRepository {
  history(auctionId: string, query: BidPagination): Promise<PublicBidPage>;
  mine(userId: string, query: BidPagination): Promise<OwnBidPage>;
}
export interface BidUseCases extends BidQueryRepository {
  placeBid(userId: string, auctionId: string, amountCents: bigint, key: string): Promise<BidReceipt>;
}
