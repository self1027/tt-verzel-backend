import { RecoveryService } from '../auctions/services/recovery-service.js';
import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import type { AnchorPublisher, AnchorVerifier } from './contracts/anchors.js';
import { DrizzleAuditRepository } from './repositories/drizzle-audit-repository.js';
import { AuditVerifier } from './services/audit-verifier.js';
import { AnchorWorker } from './services/anchor-worker.js';
import { AuditController } from './controllers/audit-controller.js';

const unavailable: AnchorPublisher & AnchorVerifier = {
  latest: () => Promise.reject(new Error('No independent witness configured')),
  publish: () => Promise.reject(new Error('No independent witness configured')),
};

export function createAuditModule(database: Database, external: AnchorPublisher & AnchorVerifier = unavailable) {
  const repository = new DrizzleAuditRepository(database);
  const recovery = new RecoveryService(database);
  const verifier = new AuditVerifier(repository, external, (result, verificationEvidence) => recovery.detect(result.auctionId, { ...result, verificationEvidence }));
  const controller = new AuditController(repository, verifier);
  const router = Router();
  router.get('/:id/audit', controller.verify);
  router.get('/:id/audit/events', controller.events);
  return { router, verifier, worker: new AnchorWorker(repository, external, (result, verificationEvidence) => recovery.detect(result.auctionId, { ...result, verificationEvidence })) };
}
