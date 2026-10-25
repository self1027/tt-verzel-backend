import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { readAuditConfig } from '../../modules/audit/infrastructure/config.js';
import { HttpAnchorProvider } from '../../modules/audit/infrastructure/http-anchor-provider.js';
import { readDatabaseURL, readSeedConfig } from '../config.js';
import { createDatabase } from './client.js';
import { seed } from './seed.js';
import { seedDemonstration } from './demo-seed.js';

async function main(): Promise<void> {
  const config = readSeedConfig(process.env);
  const audit = readAuditConfig(process.env);
  const external = audit ? new HttpAnchorProvider({ baseUrl: audit.baseUrl, namespace: audit.namespace,
    publicKey: await readFile(audit.publicKeyFile, 'utf8'), timeoutMs: audit.timeoutMs,
    allowInsecureHttpForDevelopment: audit.allowInsecureHttpForDevelopment,
    ...(audit.publishToken ? { publishToken: audit.publishToken } : {}) }) : undefined;
  const { db, pool } = createDatabase(readDatabaseURL(process.env));
  try {
    await seed(db, config);
    const results = await seedDemonstration(db, { ...(external ? { external } : {}), waitForSettlement: process.argv.includes('--wait-for-settlement') });
    console.table(results.map(result => ({ ...result, url: `/auctions/${result.id}` })));
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Seed failed. Check database, seed passwords and existing account roles/types.');
  process.exitCode = 1;
});
