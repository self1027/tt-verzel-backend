import type { Auction } from '../../auctions/contracts/auctions.js';
import type { Bid } from '../../bids/contracts/bids.js';
import type { Reservation } from '../../wallets/contracts/reservations.js';
import type { StoredTransaction } from '../../ledger/contracts/ledger.js';

export interface AuditProof { sequence: string; hash: string; stateHash: string }
export interface AuditDecision { status: 'VERIFIED' | 'PENDING_ANCHOR' | 'VERIFICATION_UNAVAILABLE' | 'TAMPERED'; proof?: AuditProof; reason?: string }
export interface SettlementAuditGate { inspect(auctionId: string): Promise<AuditDecision> }
export interface Settlement {
  id: string; auctionId: string; winningBidId: string; ledgerTransactionId: string;
  amountCents: bigint; receiptToken: string; settledAt: Date;
}
export interface SettlementOutcome {
  auctionId: string;
  status: 'SETTLED' | 'CLOSED_NO_BIDS' | 'NOT_DUE' | 'DEFERRED' | 'TAMPERED' | 'UNCHANGED';
  settlementId?: string;
  reason?: string;
  changed?: boolean;
}
export interface SettlementContext {
  lockAuction(id: string): Promise<Auction | null>;
  now(): Promise<Date>;
  findSettlement(id: string): Promise<Settlement | null>;
  proofMatches(id: string, proof: AuditProof): Promise<boolean>;
  history(id: string): Promise<Bid[]>;
  lockWallets(userIds: string[]): Promise<{ id: string; userId: string }[]>;
  lockReservations(id: string): Promise<Reservation[]>;
  capture(reservationId: string, recipientWalletId: string, key: string): Promise<Reservation>;
  ledger(key: string): Promise<StoredTransaction | null>;
  insert(settlement: Settlement): Promise<void>;
  finish(id: string, status: 'SETTLED' | 'CLOSED_NO_BIDS', at: Date): Promise<void>;
  auditSettlement(settlement: Settlement): Promise<void>;
  auditClosed(id: string, at: Date): Promise<void>;
}
export interface SettlementRepository {
  transaction<T>(work: (tx: SettlementContext) => Promise<T>): Promise<T>;
  terminal(id: string): Promise<SettlementOutcome | null>;
  due(limit: number, excluded?: string[]): Promise<string[]>;
}
export interface SettlementUseCases { settle(id: string): Promise<SettlementOutcome> }
