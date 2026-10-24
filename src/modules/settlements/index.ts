import type { Database } from '../../shared/database/client.js';
import type { AnchorVerifier } from '../audit/contracts/anchors.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../shared/events/auction-events.js';
import { DrizzleSettlementRepository } from './repositories/drizzle-settlement-repository.js';
import { DrizzleSettlementAuditGate } from './infrastructure/settlement-proof.js';
import { SettlementService } from './services/settlement-service.js';
import { SettlementWorker } from './workers/settlement-worker.js';

export function createSettlementModule(db: Database, external?: AnchorVerifier, events: AuctionEventSink = silentAuctionEvents) {
  const repository = new DrizzleSettlementRepository(db);
  const gate = new DrizzleSettlementAuditGate(db, external ?? { latest: () => Promise.reject(new Error('Witness unavailable')) });
  const service = new SettlementService(repository, gate, events);
  const worker = new SettlementWorker(repository, service, { log: entry => {
    if (['TAMPERED', 'RETRY', 'DEFERRED'].includes(entry.status)) console.warn('Settlement processing', entry);
    else if (['SETTLED', 'CLOSED_NO_BIDS'].includes(entry.status)) console.info('Settlement completed', entry);
  } });
  return { service, worker };
}
