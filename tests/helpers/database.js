import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export async function isolatedDatabase() {
  assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL is required');
  const name = `auth_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${name}"`);
  // The 23-caller concurrency test also needs connections for its lock holder and observer.
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${name}`, max: 32 });
  const db = drizzle({ client: pool });
  async function close() {
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA "${name}" CASCADE`);
    } finally {
      await admin.end();
    }
  }
  try {
    await migrate(db, { migrationsFolder: './drizzle', migrationsSchema: name });
    return { db, pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export const seedConfig = {
  auctioneerPassword: 'Auctioneer-test-2026!',
  bidder1Password: 'Bidder-one-test-2026!',
  bidder2Password: 'Bidder-two-test-2026!',
};
