import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { AuditCorruptionError } from '../contracts/errors.js';
import type { Database } from '../../../shared/database/client.js';
import { readAuctionAuditState } from '../../auctions/repositories/drizzle-auction-audit-reader.js';
import type { AuditRepository, AuditSnapshot, PendingAnchor } from '../contracts/audit.js';
import { auditAnchors, auditEvents } from '../infrastructure/schema.js';
import { auditSelection, selectedAuditEvent, MAX_AUDIT_EVENTS } from './audit-record.js';

export class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: Database) {}

  snapshot(auctionId: string): Promise<AuditSnapshot | null> {
    return this.db.transaction(async (tx) => {
      const records = await tx.select(auditSelection).from(auditEvents).where(eq(auditEvents.auctionId, auctionId))
        .orderBy(asc(auditEvents.sequence)).limit(MAX_AUDIT_EVENTS + 1);
      if (records.length > MAX_AUDIT_EVENTS) throw new AuditCorruptionError('Audit snapshot event limit exceeded');
      const operational = await readAuctionAuditState(tx, auctionId, records[0]?.record.hashVersion === 2);
      if (!operational) return null;
      return { auctionId, events: records.map(selectedAuditEvent), operational };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  async page(auctionId: string, after: bigint, limit: number) {
    if (after < 0n || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_EVENTS) throw new Error('Invalid audit page bounds');
    const records = await this.db.select(auditSelection).from(auditEvents)
      .where(and(eq(auditEvents.auctionId, auctionId), gt(auditEvents.sequence, after)))
      .orderBy(asc(auditEvents.sequence)).limit(limit);
    return records.map(selectedAuditEvent);
  }

  async pending(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_AUDIT_EVENTS) throw new Error('Invalid pending anchor limit');
    return this.db.select({ id: auditAnchors.id, auctionId: auditAnchors.auctionId,
      sequence: auditAnchors.lastSequence, hash: auditAnchors.lastHash }).from(auditAnchors)
      .where(and(isNull(auditAnchors.externalReference), isNull(auditAnchors.blockedReason)))
      .orderBy(asc(auditAnchors.lastSequence), asc(auditAnchors.auctionId), asc(auditAnchors.id)).limit(limit);
  }

  async quarantine(expected: PendingAnchor, reason: string): Promise<void> {
    const changed = await this.db.update(auditAnchors).set({ blockedReason: reason, blockedAt: new Date() })
      .where(and(eq(auditAnchors.id, expected.id), eq(auditAnchors.auctionId, expected.auctionId),
        eq(auditAnchors.lastSequence, expected.sequence), eq(auditAnchors.lastHash, expected.hash),
        isNull(auditAnchors.externalReference), isNull(auditAnchors.blockedReason))).returning({ id: auditAnchors.id });
    if (changed.length) return;
    const [existing] = await this.db.select().from(auditAnchors).where(and(eq(auditAnchors.id, expected.id),
      eq(auditAnchors.auctionId, expected.auctionId), eq(auditAnchors.lastSequence, expected.sequence),
      eq(auditAnchors.lastHash, expected.hash)));
    if (!existing?.blockedReason || existing.externalReference) throw new Error('Anchor quarantine conflict');
  }

  async confirm(id: string, reference: string, at: string, expected?: PendingAnchor): Promise<void> {
    const date = new Date(at);
    if (!reference || !Number.isFinite(date.getTime()) || date.toISOString() !== at) throw new Error('Invalid anchor confirmation');
    const commitment = expected ? and(eq(auditAnchors.auctionId, expected.auctionId),
      eq(auditAnchors.lastSequence, expected.sequence), eq(auditAnchors.lastHash, expected.hash)) : undefined;
    const changed = await this.db.update(auditAnchors).set({ externalReference: reference, anchoredAt: date })
      .where(and(eq(auditAnchors.id, id), commitment, isNull(auditAnchors.externalReference), isNull(auditAnchors.blockedReason))).returning({ id: auditAnchors.id });
    if (changed.length) return;
    const [existing] = await this.db.select({ reference: auditAnchors.externalReference }).from(auditAnchors)
      .where(and(eq(auditAnchors.id, id), commitment));
    if (!existing || existing.reference !== reference) throw new Error('Anchor confirmation conflict');
  }
}
