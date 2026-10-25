import { createHash } from 'node:crypto';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import type { OperationalState } from '../../audit/contracts/audit.js';
import { bidderReference } from '../../audit/domain/cryptography.js';
import { auctions, bids } from '../infrastructure/schema.js';
import { auctionSettlements } from '../infrastructure/settlements.schema.js';
import { AuditCorruptionError } from '../../audit/contracts/errors.js';
import { productSnapshots } from '../../catalog/infrastructure/schema.js';
import { auctionBinding } from '../../audit/domain/auction-binding.js';

export async function readAuctionBinding(tx: DatabaseTransaction, auctionId: string, lockProduct = false) {
  const [auction] = await tx.select().from(auctions).where(eq(auctions.id, auctionId));
  if (!auction) throw new AuditCorruptionError('Auction missing');
  const query = tx.select({ ...getTableColumns(productSnapshots),
    preciseCapturedAt: sql<string>`to_char(${productSnapshots.capturedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(productSnapshots).where(eq(productSnapshots.id, auction.productSnapshotId));
  const [product] = await (lockProduct ? query.for('share') : query);
  if (!product) throw new AuditCorruptionError('Product snapshot missing');
  try {
    const { preciseCapturedAt, ...fields } = product;
    return auctionBinding(auctionId, auction.auctioneerId, { ...fields, capturedAt: preciseCapturedAt });
  } catch { throw new AuditCorruptionError('Product snapshot cannot be committed'); }
}

export async function readAuctionAuditState(tx: DatabaseTransaction, auctionId: string, includeBinding = false): Promise<OperationalState | null> {
  const [auction] = await tx.select({ ...getTableColumns(auctions), canonicalDates: sql<boolean>`
    ${auctions.startsAt} = date_trunc('milliseconds', ${auctions.startsAt}) AND
    ${auctions.endsAt} = date_trunc('milliseconds', ${auctions.endsAt})` }).from(auctions).where(eq(auctions.id, auctionId));
  if (!auction) return null;
  if (!auction.canonicalDates) throw new AuditCorruptionError('Noncanonical auction timestamp');
  const bidRecords = await tx.select({ ...getTableColumns(bids), canonicalDate: sql<boolean>`
    ${bids.createdAt} = date_trunc('milliseconds', ${bids.createdAt})` }).from(bids).where(eq(bids.auctionId, auctionId)).orderBy(asc(bids.sequence)).limit(10001);
  if (bidRecords.length > 10000) throw new AuditCorruptionError('Audit snapshot limit of 10000 bids exceeded');
  const [settlement] = await tx.select({ ...getTableColumns(auctionSettlements), canonicalDate: sql<boolean>`
    ${auctionSettlements.settledAt} = date_trunc('milliseconds', ${auctionSettlements.settledAt})` })
    .from(auctionSettlements).where(eq(auctionSettlements.auctionId, auctionId));
  if (bidRecords.some((bid) => !bid.canonicalDate) || (settlement && !settlement.canonicalDate)) throw new AuditCorruptionError('Noncanonical operational timestamp');
  return {
    ...(includeBinding ? { binding: await readAuctionBinding(tx, auctionId) } : {}),
    auction: { productSnapshotId: auction.productSnapshotId, startingBidCents: auction.startingBidCents.toString(),
      minIncrementCents: auction.minIncrementCents.toString(), startsAt: auction.startsAt.toISOString(),
      endsAt: auction.endsAt.toISOString(), status: auction.status, currentBidId: auction.currentBidId },
    bids: bidRecords.map((bid) => ({ bidId: bid.id, bidderRef: bidderReference(auctionId, bid.bidderId),
      amountCents: bid.amountCents.toString(), bidSequence: bid.sequence.toString(), createdAt: bid.createdAt.toISOString() })),
    settlement: settlement ? { settlementId: settlement.id, winningBidId: settlement.winningBidId,
      ledgerTransactionId: settlement.ledgerTransactionId, amountCents: settlement.amountCents.toString(),
      settledAt: settlement.settledAt.toISOString(), receiptHash: createHash('sha256').update(settlement.receiptToken).digest('hex') } : null,
  };
}
