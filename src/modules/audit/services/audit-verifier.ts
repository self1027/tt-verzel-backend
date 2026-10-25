import type { AnchorVerifier, ExternalAnchor } from '../contracts/anchors.js';
import type { AuditRepository, AuditSnapshot, IntegrityCoverage } from '../contracts/audit.js';
import { checkChain } from '../domain/cryptography.js';
import { AppError } from '../../../shared/http/app-error.js';
import { checkOperational } from './operational-integrity.js';
import { AuditCorruptionError } from '../contracts/errors.js';

export interface VerificationResult {
  auctionId: string;
  status: 'VERIFIED' | 'PENDING_ANCHOR' | 'TAMPERED' | 'VERIFICATION_UNAVAILABLE';
  localSequence: string;
  externallyVerifiedSequence: string;
  externalHeadSequence: string | null;
  operationalCoverage: 'CONSISTENT' | 'NOT_RECORDED' | 'DIVERGENT' | 'UNAVAILABLE';
  reason: string | null;
  integrityCoverage: IntegrityCoverage;
}

export function inspectSnapshot(snapshot: AuditSnapshot, anchor: ExternalAnchor | null): VerificationResult {
  const last = snapshot.events.at(-1)?.sequence ?? 0n;
  const result: VerificationResult = { auctionId: snapshot.auctionId, status: 'PENDING_ANCHOR', localSequence: String(last),
    externallyVerifiedSequence: '0', externalHeadSequence: anchor?.sequence ?? null, operationalCoverage: 'UNAVAILABLE', reason: null,
    integrityCoverage: snapshot.events[0]?.hashVersion === 2 ? 'SELLER_PRODUCT_V2' : snapshot.events[0]?.hashVersion === 1 ? 'LEGACY_V1' : 'UNAVAILABLE' };
  const chain = checkChain(snapshot.auctionId, snapshot.events);
  if (!chain.valid) return { ...result, status: 'TAMPERED', reason: chain.reason };
  const operational = checkOperational(snapshot);
  result.operationalCoverage = operational.recorded ? (operational.consistent ? 'CONSISTENT' : 'DIVERGENT') : 'NOT_RECORDED';
  if (!operational.consistent) return { ...result, status: 'TAMPERED', reason: operational.reason };
  if (anchor) {
    const committed = snapshot.events.find((event) => String(event.sequence) === anchor.sequence);
    if (!committed || committed.eventHash !== anchor.hash) return { ...result, status: 'TAMPERED', reason: 'EXTERNAL_ANCHOR_MISMATCH' };
    result.externallyVerifiedSequence = anchor.sequence;
    if (anchor.sequence === String(last) && operational.recorded) result.status = 'VERIFIED';
  }
  return result;
}

export class AuditVerifier {
  constructor(private readonly repository: AuditRepository, private readonly external: AnchorVerifier,
    private readonly onTampered?: (result: VerificationResult, evidence?: string) => Promise<void>) {}

  async verify(auctionId: string): Promise<VerificationResult> {
    let evidence: string | undefined;
    const result = await this.inspect(auctionId, value => { evidence = value; });
    if (result.status === 'TAMPERED') await this.onTampered?.(result, evidence);
    return result;
  }

  private async inspect(auctionId: string, preserve: (evidence: string) => void): Promise<VerificationResult> {
    let anchor: ExternalAnchor | null = null;
    let available = true;
    try { anchor = await this.external.latest(auctionId); } catch { available = false; }
    // Read after the witness so a concurrently published head cannot outrun the DB snapshot.
    let snapshot: AuditSnapshot | null;
    try { snapshot = await this.repository.snapshot(auctionId); }
    catch (error) { return { auctionId, status: error instanceof AuditCorruptionError ? 'TAMPERED' : 'VERIFICATION_UNAVAILABLE',
      localSequence: '0', externallyVerifiedSequence: '0', externalHeadSequence: anchor?.sequence ?? null,
      operationalCoverage: 'UNAVAILABLE', integrityCoverage: 'UNAVAILABLE', reason: error instanceof AuditCorruptionError ? 'NONCANONICAL_STORED_TIMESTAMP' : 'SNAPSHOT_UNAVAILABLE' }; }
    preserve(JSON.stringify({ snapshot, anchor }, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value));
    if (!snapshot) {
      if (anchor) return { auctionId, status: 'TAMPERED', localSequence: '0', externallyVerifiedSequence: '0', externalHeadSequence: anchor.sequence,
        operationalCoverage: 'DIVERGENT', integrityCoverage: 'UNAVAILABLE', reason: 'ANCHORED_AUCTION_MISSING' };
      if (!available) return { auctionId, status: 'VERIFICATION_UNAVAILABLE', localSequence: '0', externallyVerifiedSequence: '0',
        externalHeadSequence: null, operationalCoverage: 'UNAVAILABLE', integrityCoverage: 'UNAVAILABLE', reason: 'WITNESS_UNAVAILABLE' };
      throw new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found');
    }
    let result: VerificationResult;
    try { result = inspectSnapshot(snapshot, anchor); }
    catch { return { auctionId, status: 'TAMPERED', localSequence: '0', externallyVerifiedSequence: '0',
      externalHeadSequence: anchor?.sequence ?? null, operationalCoverage: 'DIVERGENT', integrityCoverage: 'UNAVAILABLE', reason: 'INVALID_STORED_EVENT' }; }
    if (!available && result.status !== 'TAMPERED') return { ...result, status: 'VERIFICATION_UNAVAILABLE', reason: 'WITNESS_UNAVAILABLE' };
    return result;
  }
}
