import { sql } from 'drizzle-orm';
import { bigint, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { users } from '../../users/infrastructure/schema.js';

export const reservationStatus = pgEnum('reservation_status', ['ACTIVE', 'RELEASED', 'CAPTURED']);

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().unique().references(() => users.id),
  balanceCents: bigint('balance_cents', { mode: 'bigint' }).notNull().default(0n),
  reservedCents: bigint('reserved_cents', { mode: 'bigint' }).notNull().default(0n),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});

export const walletReservations = pgTable('wallet_reservations', {
  id: uuid('id').primaryKey(),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  auctionId: uuid('auction_id').notNull().references(() => auctions.id),
  bidId: uuid('bid_id').notNull().unique().references(() => bids.id),
  amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
  status: reservationStatus('status').notNull(),
  createdAt: timestamp('created_at').notNull(),
  releasedAt: timestamp('released_at'),
}, (table) => [
  uniqueIndex('wallet_reservations_active_auction_unique').on(table.auctionId).where(sql`${table.status} = 'ACTIVE'`),
]);

export type WalletRecord = typeof wallets.$inferSelect;
export type NewWalletRecord = typeof wallets.$inferInsert;
export type WalletReservationRecord = typeof walletReservations.$inferSelect;
export type NewWalletReservationRecord = typeof walletReservations.$inferInsert;
