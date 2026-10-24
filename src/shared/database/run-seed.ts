import 'dotenv/config';
import { readDatabaseURL, readSeedConfig } from '../config.js';
import { createDatabase } from './client.js';
import { seed } from './seed.js';
import { seedDemonstration } from './demo-seed.js';

async function main(): Promise<void> {
  const config = readSeedConfig(process.env);
  const { db, pool } = createDatabase(readDatabaseURL(process.env));
  try {
    await seed(db, config);
    await seedDemonstration(db);
    console.log('Demo seed completed');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Seed failed. Check database, seed passwords and existing account roles/types.');
  process.exitCode = 1;
});
