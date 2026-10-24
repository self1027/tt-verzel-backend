import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { bids } from '../../auctions/infrastructure/schema.js';
import { bidderReference } from '../../audit/domain/cryptography.js';
import type { BidOperationStore, BidReceipt, NewBidOperation, StoredBidOperation } from '../contracts/bids.js';
import { bidFingerprint } from '../domain/idempotency.js';
import { bidOperations } from '../infrastructure/operations.schema.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const decimal = z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const receiptSchema = z.object({
  id: uuid, auctionId: uuid, bidderRef: z.string().regex(/^[0-9a-f]{64}$/),
  amountCents: decimal, sequence: decimal, createdAt: timestamp, endsAt: timestamp,
}).strict();

function invalidOperation(): AppError {
  return new AppError(409, 'INVALID_BID_OPERATION', 'Invalid stored bid operation');
}

function receipt(value: unknown, userId: string, auctionId: string, bidId: string, fingerprint: string): BidReceipt {
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) throw invalidOperation();
  const result = parsed.data;
  if (result.id !== bidId || result.auctionId !== auctionId || result.bidderRef !== bidderReference(auctionId, userId)
    || fingerprint !== bidFingerprint(BigInt(result.amountCents))) throw invalidOperation();
  return result;
}

export class DrizzleBidOperationStore implements BidOperationStore {
  constructor(private readonly tx: DatabaseTransaction) {}

  async find(userId: string, auctionId: string, key: string): Promise<StoredBidOperation | null> {
    const [row] = await this.tx.select({ operation: bidOperations, bid: bids }).from(bidOperations)
      .innerJoin(bids, eq(bids.id, bidOperations.bidId))
      .where(and(eq(bidOperations.userId, userId), eq(bidOperations.auctionId, auctionId), eq(bidOperations.key, key))).limit(1);
    if (!row) return null;
    const result = receipt(row.operation.result, userId, auctionId, row.operation.bidId, row.operation.fingerprint);
    if (row.bid.auctionId !== auctionId || row.bid.bidderId !== userId || row.bid.amountCents.toString() !== result.amountCents
      || row.bid.sequence.toString() !== result.sequence || row.bid.createdAt.toISOString() !== result.createdAt
      || row.operation.createdAt.toISOString() !== result.createdAt) throw invalidOperation();
    return { fingerprint: row.operation.fingerprint, result };
  }

  async save(operation: NewBidOperation): Promise<void> {
    const result = receipt(operation.result, operation.userId, operation.auctionId, operation.result.id, operation.fingerprint);
    await this.tx.insert(bidOperations).values({
      id: randomUUID(), userId: operation.userId, auctionId: operation.auctionId, key: operation.key,
      fingerprint: operation.fingerprint, bidId: result.id, result, createdAt: new Date(result.createdAt),
    });
  }
}
