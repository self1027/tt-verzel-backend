import { index, integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const loginRateLimits = pgTable('login_rate_limits', {
  key: varchar('key', { length: 80 }).primaryKey(),
  attempts: integer('attempts').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, table => [index('login_rate_limits_expires_at_idx').on(table.expiresAt)]);
