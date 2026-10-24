import type { Bid, BidAuction } from '../contracts/bids.js';
import { AppError } from '../../../shared/http/app-error.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';

const extensionMs = 120000;
const positiveBigint = (value: bigint): boolean => typeof value === 'bigint' && value > 0n && value <= MAX_CENTS;
const validDate = (value: Date): boolean => value instanceof Date && Number.isFinite(+value);
const corruptHistory = (): AppError => new AppError(409, 'BID_HISTORY_CORRUPT', 'Bid history or current pointer is inconsistent');

function validBid(auction: BidAuction, bid: Bid): boolean {
  return bid.auctionId === auction.id && bid.id.length > 0 && bid.bidderId.length > 0
    && positiveBigint(bid.amountCents) && positiveBigint(bid.sequence) && validDate(bid.createdAt);
}

export function validateBid(auction: BidAuction, current: Bid | null, userId: string, amount: bigint, now: Date): Date {
  if (!positiveBigint(amount)) throw new AppError(400, 'INVALID_AMOUNT', 'Amount must be positive and within BIGINT limits');
  if (!positiveBigint(auction.startingBidCents) || !positiveBigint(auction.minIncrementCents)
    || !validDate(now) || !validDate(auction.startsAt) || !validDate(auction.endsAt) || auction.endsAt <= auction.startsAt) {
    throw new AppError(409, 'INVALID_AUCTION_STATE', 'Auction terms or clock are invalid');
  }
  if ((current?.id ?? null) !== auction.currentBidId || (current && !validBid(auction, current))) throw corruptHistory();
  if (auction.status !== 'PUBLISHED' || now < auction.startsAt || now >= auction.endsAt) {
    throw new AppError(409, 'AUCTION_NOT_LIVE', 'Bids require a live published auction');
  }
  if (current?.bidderId === userId) throw new AppError(409, 'ALREADY_LEADING', 'The current leader cannot bid again');
  const minimum = current ? current.amountCents + auction.minIncrementCents : auction.startingBidCents;
  if (minimum > MAX_CENTS || current?.sequence === MAX_CENTS) {
    throw new AppError(409, 'BID_LIMIT', 'The next bid would exceed BIGINT limits');
  }
  if (amount < minimum) throw new AppError(409, 'BID_TOO_LOW', 'Amount is below the minimum bid');
  const remaining = +auction.endsAt - +now;
  const endsAt = new Date(+auction.endsAt + (remaining > 0 && remaining <= extensionMs ? extensionMs : 0));
  if (!validDate(endsAt)) throw new AppError(409, 'INVALID_AUCTION_STATE', 'Extended deadline exceeds the supported date range');
  return endsAt;
}

/** The repository supplies complete history ordered by ascending sequence. */
export function validateHistory(auction: BidAuction, bids: Bid[]): Bid | null {
  if (!positiveBigint(auction.startingBidCents) || !positiveBigint(auction.minIncrementCents)) throw corruptHistory();
  const ids = new Set<string>();
  let expectedSequence = 1n;
  let latest: Bid | null = null;
  for (const bid of bids) {
    if (!validBid(auction, bid) || bid.sequence !== expectedSequence || ids.has(bid.id)) throw corruptHistory();
    const minimum = latest ? latest.amountCents + auction.minIncrementCents : auction.startingBidCents;
    if (bid.amountCents < minimum || (latest && (bid.bidderId === latest.bidderId || bid.createdAt < latest.createdAt))) throw corruptHistory();
    ids.add(bid.id);
    expectedSequence += 1n;
    latest = bid;
  }
  if ((latest?.id ?? null) !== auction.currentBidId) throw corruptHistory();
  return latest;
}
