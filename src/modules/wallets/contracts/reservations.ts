import type { DatabaseTransaction } from '../../../shared/database/client.js';

export interface Reservation {
  id: string;
  walletId: string;
  auctionId: string;
  bidId: string;
  amountCents: bigint;
  status: 'ACTIVE' | 'RELEASED' | 'CAPTURED';
  createdAt: Date;
  releasedAt: Date | null;
}

/** Operations use ONLY tx; lock auction, sorted wallets, then reservations.
 * Reserve/release are implemented; capture remains a SettlementService contract.
 */
export interface ReservationOperations {
  /** Positive amount <= available, matching bid/auction/wallet. Unique bidId is the key.
   * Same bid/terms returns the existing record; changed terms or terminal state conflicts.
   * Increments reserved only; balance and ledger unchanged.
   */
  reserveFunds(tx: DatabaseTransaction, input: {
    walletId: string; auctionId: string; bidId: string; amountCents: bigint;
  }): Promise<Reservation>;
  /** ACTIVE -> RELEASED, decrease reserved once, set releasedAt. RELEASED retries no-op;
   * CAPTURED conflicts. Neither balance nor ledger changes.
   */
  releaseReservation(tx: DatabaseTransaction, reservationId: string): Promise<Reservation>;
  /** ACTIVE -> CAPTURED, decrease balance AND reserved once. A balanced, append-only
   * ledger transfer to the recipient must be recorded in tx. Key binds reservation,
   * recipient and amount; identical retries return original, changed terms conflict.
   * RELEASED conflicts. No independent transaction/commit is permitted.
   */
  captureReservation(tx: DatabaseTransaction, input: {
    reservationId: string; recipientWalletId: string; idempotencyKey: string;
  }): Promise<Reservation>;
}
