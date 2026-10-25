import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auctions } from './schema.js';

// Incident journal is separate: appending to a compromised audit chain is forbidden.
export const auctionRecoveries = pgTable('auction_recoveries', {
  auctionId: uuid('auction_id').primaryKey().references(() => auctions.id),
  reason: text('reason').notNull(),
  evidence: text('evidence').notNull(),
  evidenceHash: text('evidence_hash').notNull(),
  detectedAt: timestamp('detected_at').notNull(),
  targetAt: timestamp('target_at').notNull(),
  state: text('state').$type<'PENDING' | 'RELEASED' | 'COMPENSATION_REQUIRED'>().notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at').notNull(),
  lastError: text('last_error'),
  releasedCents: bigint('released_cents', { mode: 'bigint' }).notNull().default(0n),
  capturedCents: bigint('captured_cents', { mode: 'bigint' }).notNull().default(0n),
  completedAt: timestamp('completed_at'),
}, table => [index('auction_recoveries_pending_idx').on(table.state, table.nextAttemptAt)]);
