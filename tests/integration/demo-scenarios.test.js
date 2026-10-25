import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { seed } from '../../src/shared/database/seed.ts';
import { seedDemonstration } from '../../src/shared/database/demo-seed.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { inspectSnapshot } from '../../src/modules/audit/services/audit-verifier.ts';
import { WalletService } from '../../src/modules/wallets/services/wallet-service.ts';
import { DrizzleWalletRepository } from '../../src/modules/wallets/repositories/drizzle-wallet-repository.ts';
import { ReceiptService } from '../../src/modules/settlements/services/receipt-service.ts';
import { DrizzleReceiptRepository } from '../../src/modules/settlements/repositories/drizzle-receipt-repository.ts';

async function fixture(t) {
  const f = await isolatedDatabase(); t.after(() => f.close());
  await seed(f.db, seedConfig); return f;
}
async function snapshot(f) {
  const result = {};
  for (const table of ['users', 'product_snapshots', 'auctions', 'bids', 'wallet_reservations', 'wallets', 'ledger_transactions', 'ledger_entries', 'audit_events']) {
    result[table] = (await f.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
  }
  return result;
}

test('six service-created scenarios are intact, funded once, live at real database time and concurrent replay has no effects', async t => {
  const f = await fixture(t);
  const [scenarios] = await Promise.all([seedDemonstration(f.db), seedDemonstration(f.db)]);
  assert.equal(scenarios.length, 6);
  assert.equal((await f.pool.query('SELECT count(*) FROM auctions')).rows[0].count, '6');
  assert.equal(scenarios.find(s => s.scenario === 'scheduled').lifecycleState, 'SCHEDULED');
  assert.equal(scenarios.find(s => s.scenario === 'cancelled').lifecycleState, 'CANCELLED');
  assert.equal(scenarios.find(s => s.scenario === 'live-bids').lifecycleState, 'LIVE');
  assert.equal(scenarios.find(s => s.scenario === 'closed-no-bids').lifecycleState, 'FINALIZING');
  const repository = new DrizzleAuditRepository(f.db);
  for (const scenario of scenarios) {
    const check = inspectSnapshot(await repository.snapshot(scenario.id), null);
    assert.equal(check.status, 'PENDING_ANCHOR'); assert.equal(check.operationalCoverage, 'CONSISTENT');
  }
  assert.equal((await f.pool.query('SELECT bool_and(created_at < starts_at AND starts_at < ends_at) valid FROM auctions')).rows[0].valid, true);
  const walletService = new WalletService(new DrizzleWalletRepository(f.db));
  for (const person of (await f.pool.query('SELECT id FROM users')).rows) assert.equal((await walletService.reconcile(person.id)).consistent, true);
  const reserved = (await f.pool.query("SELECT w.reserved_cents,coalesce(sum(r.amount_cents) FILTER (WHERE r.status='ACTIVE'),0)::text active FROM wallets w LEFT JOIN wallet_reservations r ON r.wallet_id=w.id GROUP BY w.id")).rows;
  assert.ok(reserved.every(w => w.reserved_cents === w.active));
  const before = await snapshot(f);
  await Promise.all([seedDemonstration(f.db), seedDemonstration(f.db)]);
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await f.pool.query("SELECT count(*) FROM ledger_transactions WHERE type='DEPOSIT'")).rows[0].count, '2');
});

test('funding failure creates no auctions or financial effects', async t => {
  const f = await fixture(t);
  await f.pool.query("DELETE FROM ledger_accounts WHERE type='SIMULATION_CLEARING'");
  await assert.rejects(seedDemonstration(f.db), /single seeded simulation clearing account/);
  assert.equal((await f.pool.query('SELECT count(*) FROM auctions')).rows[0].count, '0');
  assert.equal((await f.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
});

test('existing auction data, passwords and histories are not rewritten on replay', async t => {
  const f = await fixture(t); await seedDemonstration(f.db);
  const before = await snapshot(f);
  await f.pool.query("UPDATE auctions SET ends_at=ends_at+interval '1 day' WHERE id=(SELECT id FROM auctions ORDER BY id LIMIT 1)");
  const changed = await snapshot(f);
  await seedDemonstration(f.db);
  assert.deepEqual(await snapshot(f), changed); assert.deepEqual(changed.users, before.users);
});

test('settled and closed scenarios use a real signed isolated witness and actual elapsed time',
  { skip: process.env.DEMO_TEST_SETTLEMENT_WAIT !== '1', timeout: 240000 }, async t => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const { generateKeyPairSync } = await import('node:crypto');
    const { createWitnessServer } = await import('../../src/modules/audit/witness/server.ts');
    const { HttpAnchorProvider } = await import('../../src/modules/audit/infrastructure/http-anchor-provider.ts');
    const f = await fixture(t);
    const directory = await mkdtemp(join(tmpdir(), 'verzel-seed-witness-'));
    const keys = generateKeyPairSync('ed25519');
    const witness = await createWitnessServer({ namespace: 'isolated-seed-test', journalPath: join(directory, 'journal.jsonl'),
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publishToken: 'isolated-seed-test-token' });
    const server = witness.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await witness.close(); await rm(directory, { recursive: true, force: true }); });
    const external = new HttpAnchorProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, namespace: 'isolated-seed-test',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), publishToken: 'isolated-seed-test-token' });
    const scenarios = await seedDemonstration(f.db, { external, waitForSettlement: true });
    const settled = scenarios.find(s => s.scenario === 'settled');
    assert.equal(settled.lifecycleState, 'SETTLED');
    assert.equal(scenarios.find(s => s.scenario === 'closed-no-bids').lifecycleState, 'CLOSED_NO_BIDS');
    assert.equal((await new ReceiptService(new DrizzleReceiptRepository(f.db)).get(settled.id)).amountCents, '5000');
    const before = await snapshot(f); await seedDemonstration(f.db, { external });
    assert.deepEqual(await snapshot(f), before);
  });
