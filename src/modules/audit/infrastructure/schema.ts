import { bigint, integer, json, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { auctions } from '../../auctions/infrastructure/schema.js';

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  auctionId: uuid('auction_id').notNull().references(() => auctions.id),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  payload: json('payload').notNull(),
  previousHash: varchar('previous_hash', { length: 64 }).notNull(),
  eventHash: varchar('event_hash', { length: 64 }).notNull(),
  hashVersion: integer('hash_version').notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (table) => [
  uniqueIndex('audit_events_auction_id_sequence_unique').on(table.auctionId, table.sequence),
]);

export const auditAnchors = pgTable('audit_anchors', {
  id: uuid('id').primaryKey(),
  auctionId: uuid('auction_id').notNull().references(() => auctions.id),
  lastSequence: bigint('last_sequence', { mode: 'bigint' }).notNull(),
  lastHash: varchar('last_hash', { length: 64 }).notNull(),
  externalReference: text('external_reference'),
  blockedReason: text('blocked_reason'),
  blockedAt: timestamp('blocked_at'),
  anchoredAt: timestamp('anchored_at').notNull(),
}, (table) => [
  uniqueIndex('audit_anchors_auction_id_last_sequence_unique').on(table.auctionId, table.lastSequence),
]);

export type AuditEventRecord = typeof auditEvents.$inferSelect;
export type NewAuditEventRecord = typeof auditEvents.$inferInsert;
export type AuditAnchorRecord = typeof auditAnchors.$inferSelect;
export type NewAuditAnchorRecord = typeof auditAnchors.$inferInsert;
