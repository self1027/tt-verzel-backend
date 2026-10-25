import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { auctionRecoveries } from './recovery.schema.js';

export async function assertAuctionNotBlocked(tx: DatabaseTransaction, id: string): Promise<void> {
  const [incident] = await tx.select({ id: auctionRecoveries.auctionId }).from(auctionRecoveries).where(eq(auctionRecoveries.auctionId, id));
  if (incident) throw new AppError(409, 'AUDIT_TAMPERED', 'Confirmed tampering blocks this auction');
}
