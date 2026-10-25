export type JsonValue = null | boolean | string | number | JsonValue[] | { [key: string]: JsonValue };
export type AuditEventType = 'AUCTION_CREATED' | 'AUCTION_UPDATED' | 'AUCTION_CANCELLED' | 'BID_ACCEPTED' | 'AUCTION_SETTLED' | 'AUCTION_CLOSED_NO_BIDS';
export interface AuditInput {
  auctionId: string;
  eventType: AuditEventType;
  payload: { [key: string]: JsonValue };
  createdAt: string;
}
export interface AuditEvent extends AuditInput {
  id: string;
  sequence: bigint;
  previousHash: string;
  eventHash: string;
  hashVersion: number;
}
export interface AuditAppender { append(input: AuditInput): Promise<AuditEvent> }
export type IntegrityCoverage = 'SELLER_PRODUCT_V2' | 'LEGACY_V1' | 'UNAVAILABLE';
export interface AuctionBinding { sellerRef: string; productHash: string }
export interface AuctionCommitment {
  productSnapshotId: string;
  startingBidCents: string;
  minIncrementCents: string;
  startsAt: string;
  endsAt: string;
  status: 'PUBLISHED' | 'CANCELLED' | 'SETTLED' | 'CLOSED_NO_BIDS';
  currentBidId: string | null;
}
export interface BidCommitment {
  bidId: string;
  bidderRef: string;
  amountCents: string;
  bidSequence: string;
  createdAt: string;
}
export interface SettlementCommitment {
  settlementId: string;
  winningBidId: string;
  ledgerTransactionId: string;
  amountCents: string;
  settledAt: string;
  receiptHash: string;
}
export interface OperationalState {
  binding?: AuctionBinding;
  auction: AuctionCommitment;
  bids: BidCommitment[];
  settlement: SettlementCommitment | null;
}
export interface AuditSnapshot { auctionId: string; events: AuditEvent[]; operational: OperationalState }
export interface PendingAnchor { id: string; auctionId: string; sequence: bigint; hash: string }
export interface AuditRepository {
  snapshot(auctionId: string): Promise<AuditSnapshot | null>;
  page(auctionId: string, after: bigint, limit: number): Promise<AuditEvent[]>;
  pending(limit: number): Promise<PendingAnchor[]>;
  quarantine(expected: PendingAnchor, reason: string): Promise<void>;
  confirm(id: string, reference: string, at: string, expected?: PendingAnchor): Promise<void>;
}
