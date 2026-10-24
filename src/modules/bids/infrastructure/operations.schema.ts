import { json, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { auctions, bids } from '../../auctions/infrastructure/schema.js';
import { users } from '../../users/infrastructure/schema.js';
import type { BidReceipt } from '../contracts/bids.js';

export const bidOperations = pgTable('bid_operations', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  auctionId: uuid('auction_id').notNull().references(() => auctions.id),
  key: varchar('key', { length: 128 }).notNull(),
  fingerprint: varchar('fingerprint', { length: 64 }).notNull(),
  bidId: uuid('bid_id').notNull().unique().references(() => bids.id),
  result: json('result').$type<BidReceipt>().notNull(),
  createdAt: timestamp('created_at').notNull(),
}, table => [uniqueIndex('bid_operations_user_auction_key_unique').on(table.userId, table.auctionId, table.key)]);
