import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import type { authentication } from '../auth/middleware/authentication.js';
import { authorize } from '../auth/middleware/authorization.js';
import { AuctionController } from './controllers/auction-controller.js';
import { DrizzleAuctionRepository } from './repositories/drizzle-auction-repository.js';
import { AuctionService } from './services/auction-service.js';
import { DrizzleAuditAppender } from '../audit/repositories/drizzle-audit-appender.js';
import { createBidModule } from '../bids/index.js';
import { silentAuctionEvents, type AuctionEventSink } from '../../shared/events/auction-events.js';
import { createReceiptRouter } from '../settlements/receipt-router.js';

export function createAuctionModule(database: Database, authenticate: ReturnType<typeof authentication>, events: AuctionEventSink = silentAuctionEvents): Router {
  const controller = new AuctionController(new AuctionService(new DrizzleAuctionRepository(database, (tx) => new DrizzleAuditAppender(tx), events)));
  const router = Router();
  const auctioneer = authorize('AUCTIONEER');
  router.use(createBidModule(database, authenticate, events));
  router.use(createReceiptRouter(database));
  router.get('/', controller.list);
  router.get('/mine', authenticate, auctioneer, controller.mine);
  router.get('/:id', controller.get);
  router.post('/', authenticate, auctioneer, controller.create);
  router.patch('/:id', authenticate, auctioneer, controller.edit);
  router.post('/:id/cancel', authenticate, auctioneer, controller.cancel);
  return router;
}
