import type { AnchorPublisher, AnchorVerifier } from '../contracts/anchors.js';
import type { AuditRepository } from '../contracts/audit.js';
import { AuditCorruptionError } from '../contracts/errors.js';
import { inspectSnapshot } from './audit-verifier.js';

/** Polling durable outbox: a restart simply constructs another worker over the same repository. */
export class AnchorWorker {
  private running = false;
  private readonly blocked = new Set<string>();
  constructor(private readonly repository: AuditRepository, private readonly external: AnchorPublisher & AnchorVerifier) {}

  async runOnce(limit = 100): Promise<{ confirmed: number; failed: number; blocked: number }> {
    if (this.running) return { confirmed: 0, failed: 0, blocked: 0 };
    this.running = true;
    let confirmed = 0, failed = 0, blocked = 0;
    try {
      for (const pending of await this.repository.pending(limit)) {
        const key = `${pending.auctionId}:${pending.sequence}:${pending.hash}`;
        if (this.blocked.has(key)) continue;
        try {
          const head = await this.external.latest(pending.auctionId);
          const snapshot = await this.repository.snapshot(pending.auctionId);
          if (!snapshot) {
            this.blocked.add(key);
            blocked++;
            continue;
          }
          const check = inspectSnapshot(snapshot, head);
          if (check.status === 'TAMPERED' || check.operationalCoverage !== 'CONSISTENT') {
            this.blocked.add(key);
            blocked++;
            continue;
          }
          const event = snapshot.events.find((item) => item.sequence === pending.sequence);
          if (!event || event.eventHash !== pending.hash) {
            this.blocked.add(key);
            blocked++;
            continue;
          }
          if (head && BigInt(head.sequence) >= pending.sequence) {
            // A later external head already commits this validated prefix. Never overwrite its local receipt.
            await this.repository.confirm(pending.id, head.reference, head.publishedAt, pending);
          } else {
            const receipt = await this.external.publish({ auctionId: pending.auctionId, sequence: String(pending.sequence), hash: pending.hash }, head);
            await this.repository.confirm(pending.id, receipt.reference, receipt.publishedAt, pending);
          }
          confirmed++;
        } catch (error) {
          if (error instanceof AuditCorruptionError) {
            this.blocked.add(key);
            blocked++;
          } else failed++;
        }
      }
      return { confirmed, failed, blocked };
    } finally { this.running = false; }
  }
}
