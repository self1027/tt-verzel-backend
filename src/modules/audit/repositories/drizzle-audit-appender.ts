import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import { auctions } from '../../auctions/infrastructure/schema.js';
import type { AuditAppender, AuditEvent, AuditInput } from '../contracts/audit.js';
import { canonicalJson, checkChain, GENESIS_HASH, hashEvent, validateInput } from '../domain/cryptography.js';
import { auditAnchors, auditEvents } from '../infrastructure/schema.js';
import { auditSelection, selectedAuditEvent, MAX_AUDIT_EVENTS, MAX_NONTERMINAL_AUDIT_EVENTS } from './audit-record.js';
import { readAuctionBinding } from '../../auctions/repositories/drizzle-auction-audit-reader.js';
import { AppError } from '../../../shared/http/app-error.js';

export class DrizzleAuditAppender implements AuditAppender {
  constructor(private readonly tx: DatabaseTransaction) {}

  async append(input: AuditInput): Promise<AuditEvent> {
    canonicalJson(input);
    const candidate = structuredClone(input);
    // Parent first: the caller may already own this reentrant lock for its business write.
    const [auction] = await this.tx.select({ id: auctions.id }).from(auctions)
      .where(eq(auctions.id, candidate.auctionId)).for('update');
    if (!auction) throw new Error('Cannot append audit event for missing auction');
    const records = await this.tx.select(auditSelection).from(auditEvents).where(eq(auditEvents.auctionId, candidate.auctionId))
      .orderBy(asc(auditEvents.sequence)).limit(MAX_AUDIT_EVENTS + 1);
    const terminalTypes = ['AUCTION_SETTLED', 'AUCTION_CLOSED_NO_BIDS', 'AUCTION_CANCELLED'];
    const capacity = terminalTypes.includes(candidate.eventType) ? MAX_AUDIT_EVENTS : MAX_NONTERMINAL_AUDIT_EVENTS;
    if (records.length >= capacity) throw new AppError(409, 'AUDIT_CAPACITY_EXCEEDED', 'Auction audit capacity reached; only terminal operations remain available');
    const events = records.map(selectedAuditEvent);
    const chain = checkChain(candidate.auctionId, events);
    if (!chain.valid) throw new Error(`Cannot append to invalid audit chain: ${chain.reason ?? 'unknown reason'}`);
    const previous = events.at(-1);
    if (previous && terminalTypes.includes(previous.eventType)) throw new AppError(409, 'AUDIT_STATE_CONFLICT', 'Auction audit history is already terminal');
    const hashVersion = events[0]?.hashVersion ?? 2;
    if (!previous) {
      if (candidate.eventType !== 'AUCTION_CREATED') throw new AppError(409, 'AUDIT_STATE_CONFLICT', 'Auction audit history is inconsistent');
      if ('binding' in candidate.payload) throw new Error('Binding must originate from the creation snapshot');
      candidate.payload.binding = { ...await readAuctionBinding(this.tx, candidate.auctionId, true) };
    }
    validateInput(candidate, hashVersion);
    const unsigned = { ...candidate, id: randomUUID(), sequence: (previous?.sequence ?? 0n) + 1n,
      previousHash: previous?.eventHash ?? GENESIS_HASH, hashVersion };
    const event = { ...unsigned, eventHash: hashEvent(unsigned) };
    await this.tx.insert(auditEvents).values({ ...event, createdAt: new Date(event.createdAt) });
    await this.tx.insert(auditAnchors).values({ id: randomUUID(), auctionId: event.auctionId,
      lastSequence: event.sequence, lastHash: event.eventHash, externalReference: null, anchoredAt: new Date(event.createdAt) });
    return event;
  }
}
