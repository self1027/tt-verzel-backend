import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { seed } from '../../src/shared/database/seed.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { checkChain } from '../../src/modules/audit/domain/cryptography.ts';

let f;
before(async () => { f = await isolatedDatabase(); await seed(f.db, seedConfig); });
after(async () => { await f?.close(); });

test('demonstration seed is atomic, audited, local, funded once and preserves existing data on concurrent replay', async () => {
  const module = await import('../../src/shared/database/demo-seed.ts').catch(() => ({}));
  assert.equal(typeof module.seedDemonstration, 'function', 'demo seed export exists');
  const { seedDemonstration } = module;
  const passwords = (await f.pool.query('SELECT email,password_hash FROM users ORDER BY email')).rows;
  await Promise.all([seedDemonstration(f.db), seedDemonstration(f.db)]);
  const rows = (await f.pool.query('SELECT * FROM auctions')).rows;
  assert.equal(rows.length, 1);
  const auction = rows[0];
  assert.equal(auction.status, 'PUBLISHED');
  assert.equal(auction.current_bid_id, null);
  const timing = (await f.pool.query(`SELECT starts_at < clock_timestamp() AT TIME ZONE 'UTC' AS started,
    ends_at > clock_timestamp() AT TIME ZONE 'UTC' AS active,
    to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_iso FROM auctions`)).rows[0];
  assert.ok(timing.started && timing.active);
  assert.ok(+new Date(auction.created_at) < +new Date(auction.starts_at));
  const snapshot = (await f.pool.query('SELECT * FROM product_snapshots WHERE id=$1', [auction.product_snapshot_id])).rows[0];
  const original = JSON.parse(await readFile(new URL('../fixtures/dummyjson/product_1.json', import.meta.url), 'utf8'));
  assert.equal(snapshot.title, original.title);
  assert.equal(snapshot.description, original.description);
  assert.equal(snapshot.image_url, original.thumbnail);
  assert.equal(snapshot.external_id, String(original.id));
  for (const forbidden of ['reviews', 'reviewerEmail', 'price']) assert.ok(!JSON.stringify(snapshot).includes(`"${forbidden}"`));
  assert.ok(snapshot.attributes.demoProvenance);
  const events = (await f.pool.query('SELECT * FROM audit_events')).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'AUCTION_CREATED');
  assert.equal(events[0].payload.startsAt, timing.start_iso);
  assert.equal(events[0].payload.productSnapshotId, snapshot.id);
  assert.equal(+new Date(events[0].created_at), +new Date(auction.created_at));
  assert.equal((await f.pool.query('SELECT * FROM audit_anchors')).rows.length, 1);
  const audit = await new DrizzleAuditRepository(f.db).snapshot(auction.id);
  assert.equal(checkChain(auction.id, audit.events).valid, true);
  assert.deepEqual(audit.events[0].payload, audit.operational.auction);
  assert.equal((await f.pool.query('SELECT * FROM bids')).rows.length, 0);
  const funding = (await f.pool.query('SELECT * FROM ledger_transactions ORDER BY id')).rows;
  assert.equal(funding.length, 2);
  for (const tx of funding) {
    assert.equal(tx.type, 'DEPOSIT');
    assert.ok(tx.idempotency_key.endsWith(':demo-bootstrap-v1'));
    const entries = (await f.pool.query('SELECT amount_cents FROM ledger_entries WHERE transaction_id=$1', [tx.id])).rows;
    assert.equal(entries.length, 2);
    assert.equal(entries.reduce((sum, entry) => sum + BigInt(entry.amount_cents), 0n), 0n);
  }
  const balances = (await f.pool.query('SELECT balance_cents FROM wallets JOIN users ON wallets.user_id=users.id WHERE role=\'BIDDER\'')).rows;
  assert.deepEqual(balances.map((row) => row.balance_cents), ['100000', '100000']);
  await Promise.all([seedDemonstration(f.db), seedDemonstration(f.db), seedDemonstration(f.db)]);
  assert.deepEqual((await f.pool.query('SELECT * FROM auctions')).rows, rows);
  assert.deepEqual((await f.pool.query('SELECT * FROM audit_events')).rows, events);
  assert.deepEqual((await f.pool.query('SELECT * FROM ledger_transactions ORDER BY id')).rows, funding);
  assert.deepEqual((await f.pool.query('SELECT email,password_hash FROM users ORDER BY email')).rows, passwords);
  await f.pool.query("UPDATE auctions SET status='CLOSED_NO_BIDS', starts_at=now()-interval '2 hour', ends_at=now()-interval '1 hour'");
  const closed = (await f.pool.query('SELECT * FROM auctions')).rows;
  await seedDemonstration(f.db);
  assert.deepEqual((await f.pool.query('SELECT * FROM auctions')).rows, closed);
});

test('failed funding rolls back all demo work and preserves pristine wallets', async () => {
  const { seedDemonstration } = await import('../../src/shared/database/demo-seed.ts');
  const isolated = await isolatedDatabase();
  try {
    await seed(isolated.db, seedConfig);
    await isolated.pool.query("DELETE FROM ledger_accounts WHERE type='SIMULATION_CLEARING'");
    await assert.rejects(seedDemonstration(isolated.db), /single seeded simulation clearing account/);
    assert.equal((await isolated.pool.query('SELECT * FROM auctions')).rows.length, 0);
    assert.equal((await isolated.pool.query('SELECT * FROM ledger_transactions')).rows.length, 0);
    assert.equal((await isolated.pool.query('SELECT * FROM wallets WHERE balance_cents <> 0')).rows.length, 0);
  } finally { await isolated.close(); }
});

test('pristine check skips zero wallets with history and funded wallets without history', async () => {
  const { seedDemonstration } = await import('../../src/shared/database/demo-seed.ts');
  const isolated = await isolatedDatabase();
  try {
    await seed(isolated.db, seedConfig);
    const wallets = (await isolated.pool.query("SELECT wallets.id, users.id AS user_id, email FROM wallets JOIN users ON users.id=wallets.user_id WHERE role='BIDDER' ORDER BY email")).rows;
    await isolated.pool.query('UPDATE wallets SET balance_cents=7 WHERE id=$1', [wallets[0].id]);
    const account = (await isolated.pool.query('SELECT id FROM ledger_accounts WHERE wallet_id=$1', [wallets[1].id])).rows[0];
    await isolated.pool.query("INSERT INTO ledger_transactions (id,type,idempotency_key,created_at) VALUES ('ae88dcb2-fb85-4888-8b15-1a9926d1bfb1','DEPOSIT','existing-history',now())");
    await isolated.pool.query("INSERT INTO ledger_entries (id,transaction_id,account_id,amount_cents,created_at) VALUES ('ae88dcb2-fb85-4888-8b15-1a9926d1bfb2','ae88dcb2-fb85-4888-8b15-1a9926d1bfb1',$1,0,now())", [account.id]);
    await seedDemonstration(isolated.db);
    assert.deepEqual((await isolated.pool.query("SELECT balance_cents FROM wallets JOIN users ON users.id=wallets.user_id WHERE role='BIDDER' ORDER BY email")).rows.map((w) => w.balance_cents), ['7', '0']);
    assert.equal((await isolated.pool.query('SELECT * FROM ledger_transactions')).rows.length, 1);
  } finally { await isolated.close(); }
});
