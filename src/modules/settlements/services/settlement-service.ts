import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/http/app-error.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../../shared/events/auction-events.js';
import { validateHistory } from '../../bids/domain/bid-rules.js';
import type { Settlement, SettlementAuditGate, SettlementOutcome, SettlementRepository, SettlementUseCases } from '../contracts/settlements.js';

export class SettlementService implements SettlementUseCases {
  constructor(private readonly repository: SettlementRepository, private readonly gate: SettlementAuditGate,
    private readonly events: AuctionEventSink = silentAuctionEvents) {}

  async settle(id: string): Promise<SettlementOutcome> {
    const terminal = await this.repository.terminal(id);
    if (terminal) return terminal;
    // All external I/O precedes BEGIN/financial locks.
    const decision = await this.gate.inspect(id);
    if (decision.status === 'TAMPERED') {
      try { this.events.publish({ type: 'auction:integrity-warning', auctionId: id, data: { reason: 'AUDIT_TAMPERED' } }); } catch { /* Best effort hint. */ }
      return { auctionId: id, status: 'TAMPERED', reason: 'AUDIT_TAMPERED' };
    }
    const proof = decision.proof;
    if (decision.status !== 'VERIFIED' || !proof) return { auctionId: id, status: 'DEFERRED', reason: decision.reason ?? decision.status };
    const result = await this.repository.transaction(async tx => {
      const auction = await tx.lockAuction(id);
      if (!auction) throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
      const now = await tx.now();
      if (auction.status === 'SETTLED') {
        const existing = await tx.findSettlement(id);
        if (!existing) throw new AppError(409, 'SETTLEMENT_CONFLICT', 'Settlement record is missing');
        return { auctionId: id, status: 'SETTLED' as const, settlementId: existing.id };
      }
      if (auction.status !== 'PUBLISHED') return { auctionId: id, status: 'UNCHANGED' as const };
      if (now < auction.endsAt) return { auctionId: id, status: 'NOT_DUE' as const };
      if (!await tx.proofMatches(id, proof)) return { auctionId: id, status: 'DEFERRED' as const, reason: 'AUDIT_VERSION_CHANGED' };
      const current = validateHistory(auction, await tx.history(id));
      if (!current) {
        if ((await tx.lockReservations(id)).length) throw new AppError(409, 'RESERVATION_CONFLICT', 'Unexpected reservation without bids');
        const at = await tx.now();
        if (!await tx.proofMatches(id, proof)) return { auctionId: id, status: 'DEFERRED' as const, reason: 'AUDIT_VERSION_CHANGED' };
        await tx.finish(id, 'CLOSED_NO_BIDS', at);
        await tx.auditClosed(id, at);
        return { auctionId: id, status: 'CLOSED_NO_BIDS' as const, changed: true };
      }
      const wallets = await tx.lockWallets([current.bidderId, auction.auctioneerId]);
      const seller = wallets.find(wallet => wallet.userId === auction.auctioneerId);
      const winner = wallets.find(wallet => wallet.userId === current.bidderId);
      const reservations = await tx.lockReservations(id);
      const reservation = reservations[0];
      if (!seller || !winner || reservations.length !== 1 || !reservation || reservation.bidId !== current.id ||
          reservation.walletId !== winner.id || reservation.amountCents !== current.amountCents) throw new AppError(409, 'RESERVATION_CONFLICT', 'Winning reservation is inconsistent');
      const at = await tx.now();
      if (at < auction.endsAt || !await tx.proofMatches(id, proof)) return { auctionId: id, status: 'DEFERRED' as const, reason: 'AUDIT_VERSION_CHANGED' };
      const key = `settlement:${id}`;
      await tx.capture(reservation.id, seller.id, key);
      const ledger = await tx.ledger(key);
      if (!ledger || ledger.transaction.type !== 'AUCTION_SETTLEMENT' || ledger.transaction.referenceId !== reservation.id) throw new AppError(409, 'SETTLEMENT_CONFLICT', 'Capture ledger record is inconsistent');
      const settlement: Settlement = { id: randomUUID(), auctionId: id, winningBidId: current.id, amountCents: current.amountCents,
        ledgerTransactionId: ledger.transaction.id, receiptToken: randomUUID(), settledAt: at };
      await tx.insert(settlement);
      await tx.finish(id, 'SETTLED', at);
      await tx.auditSettlement(settlement);
      return { auctionId: id, status: 'SETTLED' as const, settlementId: settlement.id, changed: true };
    });
    if (result.changed) {
      try {
        this.events.publish({ type: 'auction:ended', auctionId: id, data: { status: result.status } });
        if (result.status === 'SETTLED') this.events.publish({ type: 'auction:settled', auctionId: id, data: { settlementId: result.settlementId, receiptUrl: `/auctions/${id}/receipt` } });
      } catch { /* Never turn a committed operation into a failed HTTP/job result. */ }
    }
    return result;
  }
}
