import { asc, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { readAuctionAuditState } from '../../auctions/repositories/drizzle-auction-audit-reader.js';
import type { AuditAppender } from '../../audit/contracts/audit.js';
import { bidderReference, checkChain } from '../../audit/domain/cryptography.js';
import { auditEvents } from '../../audit/infrastructure/schema.js';
import { auditSelection, MAX_AUDIT_EVENTS, selectedAuditEvent } from '../../audit/repositories/audit-record.js';
import { checkOperational } from '../../audit/services/operational-integrity.js';
import type { Bid } from '../contracts/bids.js';

export async function appendAcceptedBid(tx: DatabaseTransaction, bid: Bid, endsAt: Date, audit: AuditAppender): Promise<void> {
  await audit.append({ auctionId: bid.auctionId, eventType: 'BID_ACCEPTED', createdAt: bid.createdAt.toISOString(),
    payload: { bidId: bid.id, bidderRef: bidderReference(bid.auctionId, bid.bidderId), amountCents: bid.amountCents.toString(),
      bidSequence: bid.sequence.toString(), createdAt: bid.createdAt.toISOString(), endsAt: endsAt.toISOString() } });
  // Validate the complete post-write history in the caller's transaction before accepting its receipt.
  try {
    const records = await tx.select(auditSelection).from(auditEvents).where(eq(auditEvents.auctionId, bid.auctionId))
      .orderBy(asc(auditEvents.sequence)).limit(MAX_AUDIT_EVENTS + 1);
    if (records.length > MAX_AUDIT_EVENTS) throw new Error('Audit history limit exceeded');
    const events = records.map(selectedAuditEvent);
    const operational = await readAuctionAuditState(tx, bid.auctionId);
    if (!operational || !checkChain(bid.auctionId, events).valid) throw new Error('Invalid audit state');
    const check = checkOperational({ auctionId: bid.auctionId, events, operational });
    if (!check.recorded || !check.consistent) throw new Error('Invalid audit coverage');
  } catch {
    throw new AppError(409, 'AUDIT_STATE_CONFLICT', 'Auction audit history is inconsistent');
  }
}
