import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/http/app-error.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';
import { bidderReference } from '../../audit/domain/cryptography.js';
import type { Bid, BidPagination, BidQueryRepository, BidReceipt, BidRepository, BidUseCases } from '../contracts/bids.js';
import { validateBid, validateHistory } from '../domain/bid-rules.js';
import { bidFingerprint } from '../domain/idempotency.js';

export class BidService implements BidUseCases {
  constructor(private readonly repository: BidRepository, private readonly queries: BidQueryRepository) {}

  async placeBid(userId: string, auctionId: string, amountCents: bigint, key: string): Promise<BidReceipt> {
    if (amountCents <= 0n || amountCents > MAX_CENTS) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be a positive BIGINT');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Invalid Idempotency-Key');
    const fingerprint = bidFingerprint(amountCents);
    return this.repository.transaction(async (tx) => {
      const auction = await tx.lockAuction(auctionId);
      if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
      const initialNow = await tx.databaseNow();
      const actor = await tx.actor(userId);
      if (!actor) throw new AppError(401, 'UNAUTHENTICATED', 'User no longer exists');
      if (actor.role !== 'BIDDER') throw new AppError(403, 'BIDDER_REQUIRED', 'Only bidders may place bids');
      const previous = await tx.operations.find(userId, auctionId, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used with another payload');
        return previous.result;
      }
      const current = validateHistory(auction, await tx.history(auctionId));
      validateBid(auction, current, userId, amountCents, initialNow);
      const wallets = await tx.lockWallets(current ? [userId, current.bidderId] : [userId]);
      const wallet = wallets.find((item) => item.userId === userId);
      const oldWallet = current ? wallets.find((item) => item.userId === current.bidderId) : undefined;
      if (!wallet || (current && !oldWallet)) throw new AppError(409, 'INVALID_WALLET_STATE', 'A required wallet is missing');
      const active = await tx.lockReservations(auctionId);
      const oldReservation = active[0];
      if (current ? active.length !== 1 || oldReservation?.bidId !== current.id || oldReservation.amountCents !== current.amountCents ||
          oldReservation.walletId !== oldWallet?.id : active.length !== 0) {
        throw new AppError(409, 'RESERVATION_CONFLICT', 'Current leader reservation is inconsistent');
      }
      // Wallets may have waited behind deposits/other auctions: decide on the DB clock AFTER every lock wait.
      const at = await tx.databaseNow();
      const endsAt = validateBid(auction, current, userId, amountCents, at);
      if (wallet.balanceCents - wallet.reservedCents < amountCents) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'Available balance is insufficient');
      if (oldReservation) await tx.releaseReservation(oldReservation.id);
      const bid: Bid = { id: randomUUID(), auctionId, bidderId: userId, amountCents, sequence: (current?.sequence ?? 0n) + 1n, createdAt: at };
      await tx.insertBid(bid);
      await tx.reserveFunds({ walletId: wallet.id, auctionId, bidId: bid.id, amountCents });
      await tx.updateLeader(auctionId, bid.id, endsAt, at);
      await tx.appendAudit(bid, endsAt);
      const result: BidReceipt = { id: bid.id, auctionId, bidderRef: bidderReference(auctionId, userId),
        amountCents: amountCents.toString(), sequence: bid.sequence.toString(), createdAt: at.toISOString(), endsAt: endsAt.toISOString() };
      await tx.operations.save({ userId, auctionId, key, fingerprint, result });
      return result;
    });
  }

  history(auctionId: string, query: BidPagination) { return this.queries.history(auctionId, query); }
  mine(userId: string, query: BidPagination) { return this.queries.mine(userId, query); }
}
