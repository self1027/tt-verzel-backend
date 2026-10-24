import type { AuctionCommitment, AuditSnapshot, BidCommitment, SettlementCommitment } from '../contracts/audit.js';
import { canonicalJson } from '../domain/cryptography.js';

export interface OperationalCheck { consistent: boolean; recorded: boolean; reason: string | null }
const mismatch = (reason: string): OperationalCheck => ({ consistent: false, recorded: true, reason });

/** Replays public commitments, never accesses another module's persistence. */
export function checkOperational(snapshot: AuditSnapshot): OperationalCheck {
  let auction: AuctionCommitment | undefined;
  const bids: BidCommitment[] = [];
  let settlement: SettlementCommitment | null = null;
  for (const event of snapshot.events) {
    const p = event.payload;
    if (event.eventType === 'AUCTION_CREATED') {
      if (auction || event.sequence !== 1n) return mismatch('INVALID_AUCTION_GENESIS');
      auction = p as unknown as AuctionCommitment;
      if (auction.currentBidId !== null) return mismatch('INVALID_AUCTION_GENESIS');
    } else if (!auction) {
      return mismatch('MISSING_AUCTION_COMMITMENT');
    } else if (event.eventType === 'AUCTION_UPDATED' || event.eventType === 'AUCTION_CANCELLED') {
      const state = Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'reason'));
      if (bids.length || auction.status !== 'PUBLISHED') return mismatch('INVALID_AUCTION_TRANSITION');
      if (p.productSnapshotId !== auction.productSnapshotId ||
          (event.eventType === 'AUCTION_UPDATED' && (event.createdAt >= auction.startsAt || typeof p.startsAt !== 'string' || event.createdAt >= p.startsAt)) ||
          (event.eventType === 'AUCTION_CANCELLED' && (event.createdAt >= auction.endsAt ||
            canonicalJson({ ...state, status: auction.status }) !== canonicalJson(auction)))) return mismatch('INVALID_AUCTION_TRANSITION');
      auction = state as unknown as AuctionCommitment;
      if (auction.currentBidId !== null) return mismatch('UNRECORDED_CURRENT_BID');
    } else if (event.eventType === 'BID_ACCEPTED') {
      const { endsAt, ...bid } = p;
      const next = bid as unknown as BidCommitment;
      const previous = bids.at(-1);
      const minimum = previous ? BigInt(previous.amountCents) + BigInt(auction.minIncrementCents) : BigInt(auction.startingBidCents);
      const remaining = Date.parse(auction.endsAt) - Date.parse(next.createdAt);
      const expectedEndsAt = remaining > 0 && remaining <= 120000
        ? new Date(Date.parse(auction.endsAt) + 120000).toISOString() : auction.endsAt;
      if (auction.status !== 'PUBLISHED' || next.bidSequence !== String(bids.length + 1) ||
          BigInt(next.amountCents) < minimum || next.bidderRef === previous?.bidderRef ||
          next.createdAt !== event.createdAt || next.createdAt < auction.startsAt || next.createdAt >= auction.endsAt ||
          endsAt !== expectedEndsAt) return mismatch('INVALID_BID_COMMITMENT');
      bids.push(next);
      auction = { ...auction, currentBidId: next.bidId, endsAt };
    } else if (event.eventType === 'AUCTION_SETTLED') {
      const last = bids.at(-1);
      const next = p as unknown as SettlementCommitment;
      if (auction.status !== 'PUBLISHED' || settlement || !last || next.winningBidId !== last.bidId ||
          next.amountCents !== last.amountCents || next.settledAt < auction.endsAt) return mismatch('INVALID_SETTLEMENT_COMMITMENT');
      settlement = next;
      auction = { ...auction, status: 'SETTLED' };
    } else {
      if (auction.status !== 'PUBLISHED' || bids.length || event.createdAt < auction.endsAt) return mismatch('INVALID_CLOSE_COMMITMENT');
      auction = { ...auction, status: 'CLOSED_NO_BIDS' };
    }
  }
  if (!auction) {
    return snapshot.operational.bids.length || snapshot.operational.settlement || snapshot.operational.auction.currentBidId
      ? mismatch('UNRECORDED_OPERATIONAL_HISTORY') : { consistent: true, recorded: false, reason: null };
  }
  const expected = { auction, bids, settlement };
  if (canonicalJson(expected) !== canonicalJson(snapshot.operational)) return mismatch('OPERATIONAL_STATE_MISMATCH');
  return { consistent: true, recorded: true, reason: null };
}
