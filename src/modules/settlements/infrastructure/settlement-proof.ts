import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../../shared/database/client.js';
import type { AnchorVerifier } from '../../audit/contracts/anchors.js';
import { canonicalJson, GENESIS_HASH } from '../../audit/domain/cryptography.js';
import { inspectSnapshot } from '../../audit/services/audit-verifier.js';
import { AuditCorruptionError } from '../../audit/contracts/errors.js';
import { auditEvents } from '../../audit/infrastructure/schema.js';
import { auditSelection, selectedAuditEvent, MAX_AUDIT_EVENTS } from '../../audit/repositories/audit-record.js';
import { auctions } from '../../auctions/infrastructure/schema.js';
import { readAuctionAuditState } from '../../auctions/repositories/drizzle-auction-audit-reader.js';
import type { SettlementAuditGate } from '../contracts/settlements.js';

export async function readSettlementProof(tx: DatabaseTransaction, id: string) {
  const [auction] = await tx.select({ sellerId: auctions.auctioneerId }).from(auctions).where(eq(auctions.id, id));
  const operational = await readAuctionAuditState(tx, id);
  if (!auction || !operational) throw new AuditCorruptionError('Auction missing');
  const rows = await tx.select(auditSelection).from(auditEvents).where(eq(auditEvents.auctionId, id)).orderBy(asc(auditEvents.sequence)).limit(MAX_AUDIT_EVENTS + 1);
  if (rows.length > MAX_AUDIT_EVENTS) throw new Error('Audit history limit exceeded');
  const events = rows.map(selectedAuditEvent);
  const last = events.at(-1);
  return { snapshot: { auctionId: id, operational, events }, proof: {
    sequence: String(last?.sequence ?? 0n), hash: last?.eventHash ?? GENESIS_HASH,
    stateHash: createHash('sha256').update(canonicalJson({ operational, sellerId: auction.sellerId })).digest('hex'),
  } };
}

export class DrizzleSettlementAuditGate implements SettlementAuditGate {
  constructor(private readonly db: Database, private readonly external: AnchorVerifier) {}
  async inspect(id: string) {
    let anchor;
    try { anchor = await this.external.latest(id); }
    catch { return { status: 'VERIFICATION_UNAVAILABLE' as const }; }
    try {
      return await this.db.transaction(async tx => {
        const state = await readSettlementProof(tx, id);
        const result = inspectSnapshot(state.snapshot, anchor);
        return result.status === 'VERIFIED' ? { status: result.status, proof: state.proof } : { status: result.status };
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    } catch (error) {
      return { status: error instanceof AuditCorruptionError ? 'TAMPERED' as const : 'VERIFICATION_UNAVAILABLE' as const };
    }
  }
}
