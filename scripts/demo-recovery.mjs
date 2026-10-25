import 'dotenv/config';
import { pathToFileURL } from 'node:url';

export function assertIsolatedDemoEnvironment(env) {
  if (!['development', 'test'].includes(env.NODE_ENV)) throw new Error('Recovery demo requires NODE_ENV=development or test');
  if (!env.TEST_DATABASE_URL) throw new Error('Recovery demo requires TEST_DATABASE_URL; DATABASE_URL is never used');
  const url = new URL(env.TEST_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/(?:test|sandbox|demo)/i.test(url.pathname)) throw new Error('Recovery demo requires a named local test/demo database');
}

export async function runRecoveryDemo() {
  assertIsolatedDemoEnvironment(process.env);
  const { isolatedDatabase, seedConfig } = await import('../tests/helpers/database.js');
  const { seed } = await import('../src/shared/database/seed.ts');
  const { seedDemonstration } = await import('../src/shared/database/demo-seed.ts');
  const { AuditVerifier } = await import('../src/modules/audit/services/audit-verifier.ts');
  const { DrizzleAuditRepository } = await import('../src/modules/audit/repositories/drizzle-audit-repository.ts');
  const { RecoveryService } = await import('../src/modules/auctions/services/recovery-service.ts');
  const { AuctionService } = await import('../src/modules/auctions/services/auction-service.ts');
  const { DrizzleAuctionRepository } = await import('../src/modules/auctions/repositories/drizzle-auction-repository.ts');
  // This helper creates a new UUID schema, migrates only it and removes only that owned schema.
  const isolated = await isolatedDatabase();
  try {
    await seed(isolated.db, seedConfig);
    const scenarios = await seedDemonstration(isolated.db);
    const auction = scenarios.find(scenario => scenario.scenario === 'live-bids');
    if (!auction) throw new Error('Recovery demo auction missing');
    await isolated.pool.query("UPDATE audit_events SET event_hash=repeat('f',64) WHERE auction_id=$1 AND sequence=1", [auction.id]);
    const recovery = new RecoveryService(isolated.db);
    // No publisher, witness configuration, HTTP or shared witness is used by this local hash attack.
    const verifier = new AuditVerifier(new DrizzleAuditRepository(isolated.db), { latest: async () => null },
      (result, verificationEvidence) => recovery.detect(result.auctionId, { ...result, verificationEvidence }));
    const verification = await verifier.verify(auction.id);
    const result = await new AuctionService(new DrizzleAuctionRepository(isolated.db)).get(auction.id);
    if (verification.status !== 'TAMPERED' || result.recovery?.state !== 'RELEASED' || result.status !== 'CANCELLED') throw new Error('Recovery demo did not reach confirmed release');
    return { isolated: true, ephemeral: true, witnessUsed: false, auctionId: auction.id,
      integrity: verification.status, status: result.status, recovery: result.recovery };
  } finally { await isolated.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecoveryDemo().then(result => { console.log(JSON.stringify(result, null, 2)); })
    .catch(error => { console.error(error instanceof Error ? error.message : 'Recovery demonstration failed'); process.exitCode = 1; });
}
