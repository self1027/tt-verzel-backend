import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import { ReceiptController } from './controllers/receipt-controller.js';
import { DrizzleReceiptRepository } from './repositories/drizzle-receipt-repository.js';
import { ReceiptService } from './services/receipt-service.js';

export function createReceiptRouter(db: Database): Router {
  const router = Router();
  const controller = new ReceiptController(new ReceiptService(new DrizzleReceiptRepository(db)));
  router.get('/:id/receipt', controller.get);
  return router;
}
