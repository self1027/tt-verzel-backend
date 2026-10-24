import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import type { authentication } from '../auth/middleware/authentication.js';
import { authorize } from '../auth/middleware/authorization.js';
import { DrizzleAuditAppender } from '../audit/repositories/drizzle-audit-appender.js';
import { DrizzleReservationOperations } from '../wallets/repositories/drizzle-reservation-operations.js';
import { BidService } from './services/bid-service.js';
import { DrizzleBidRepository } from './repositories/drizzle-bid-repository.js';
import { DrizzleBidQueryRepository } from './repositories/drizzle-bid-query-repository.js';
import { BidController } from './controllers/bid-controller.js';

export function createBidModule(db: Database, authenticate: ReturnType<typeof authentication>): Router {
  const controller = new BidController(new BidService(new DrizzleBidRepository(db, new DrizzleReservationOperations(),
    (tx) => new DrizzleAuditAppender(tx)), new DrizzleBidQueryRepository(db)));
  const router = Router();
  router.get('/bids/mine', authenticate, authorize('BIDDER'), controller.mine);
  router.get('/:auctionId/bids', controller.history);
  router.post('/:auctionId/bids', authenticate, authorize('BIDDER'), controller.placeBid);
  return router;
}
