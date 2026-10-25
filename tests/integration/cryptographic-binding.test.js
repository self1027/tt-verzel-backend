import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settlementFixture } from '../helpers/settlements.js';
import { serve } from '../helpers/http.js';
import { WalletService } from '../../src/modules/wallets/services/wallet-service.ts';
import { DrizzleWalletRepository } from '../../src/modules/wallets/repositories/drizzle-wallet-repository.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { AuditVerifier } from '../../src/modules/audit/services/audit-verifier.ts';
import { AnchorWorker } from '../../src/modules/audit/services/anchor-worker.ts';
import { createWitnessServer } from '../../src/modules/audit/witness/server.ts';
import { HttpAnchorProvider } from '../../src/modules/audit/infrastructure/http-anchor-provider.ts';
import { DrizzleReceiptRepository } from '../../src/modules/settlements/repositories/drizzle-receipt-repository.ts';
import { ReceiptService } from '../../src/modules/settlements/services/receipt-service.ts';
import { SettlementService } from '../../src/modules/settlements/services/settlement-service.ts';
import { DrizzleSettlementAuditGate } from '../../src/modules/settlements/infrastructure/settlement-proof.ts';
import { hashEvent, GENESIS_HASH } from '../../src/modules/audit/domain/cryptography.ts';
import { waitBlocked } from '../helpers/bid-locks.js';
import { AuctionService } from '../../src/modules/auctions/services/auction-service.ts';
import { DrizzleAuctionRepository } from '../../src/modules/auctions/repositories/drizzle-auction-repository.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';
import { readAuctionBinding } from '../../src/modules/auctions/repositories/drizzle-auction-audit-reader.ts';

async function fixture(t) {
  const f = await settlementFixture();
  t.after(() => f.close());
  return { ...f, verifier: new AuditVerifier(new DrizzleAuditRepository(f.db), f.external), receipts: new ReceiptService(new DrizzleReceiptRepository(f.db)) };
}
async function finances(f) {
  return {
    wallets: (await f.pool.query('SELECT id,balance_cents::text,reserved_cents::text FROM wallets ORDER BY id')).rows,
    reservations: (await f.pool.query('SELECT id,status FROM wallet_reservations ORDER BY id')).rows,
    settlements: (await f.pool.query('SELECT id FROM auction_settlements ORDER BY id')).rows,
    ledger: (await f.pool.query('SELECT id FROM ledger_transactions ORDER BY id')).rows,
  };
}
async function alternateSeller(f) {
  const id = randomUUID();
  await f.pool.query('INSERT INTO users(id,email,password_hash,display_name,role,created_at,updated_at) SELECT $1,$2,password_hash,$3,role,created_at,updated_at FROM users WHERE id=$4', [id, `${id}@test.invalid`, 'Other seller', f.users.auctioneer]);
  await new WalletService(new DrizzleWalletRepository(f.db)).get(id);
  return id;
}
// Build legacy data BEFORE publishing its checkpoint; never rewrite an existing signed witness.
async function legacyFixture(f, id) {
  const events = (await new DrizzleAuditRepository(f.db).snapshot(id)).events;
  let previousHash = GENESIS_HASH;
  for (const event of events) {
    const unsigned = { ...event }; delete unsigned.eventHash;
    unsigned.hashVersion = 1; unsigned.previousHash = previousHash;
    if (unsigned.eventType === 'AUCTION_CREATED') {
      const payload = { ...unsigned.payload }; delete payload.binding; unsigned.payload = payload;
    }
    previousHash = hashEvent(unsigned);
    await f.pool.query('UPDATE audit_events SET hash_version=1,payload=$1,previous_hash=$2,event_hash=$3 WHERE id=$4', [JSON.stringify(unsigned.payload), unsigned.previousHash, previousHash, event.id]);
    await f.pool.query('UPDATE audit_anchors SET last_hash=$1,external_reference=NULL WHERE auction_id=$2 AND last_sequence=$3', [previousHash, id, String(event.sequence)]);
  }
  await f.anchor(id);
}
for (const anchored of [false, true]) {
  test(`seller substitution ${anchored ? 'after' : 'before'} anchoring is detected without any transfer`, async t => {
    const f = await fixture(t); const a = await f.expiredAuction(); const other = await alternateSeller(f);
    if (!anchored) f.heads.clear();
    const before = await finances(f);
    await f.pool.query('UPDATE auctions SET auctioneer_id=$1 WHERE id=$2', [other, a.id]);
    const result = await f.verifier.verify(a.id);
    assert.equal(result.status, 'TAMPERED');
    assert.equal((await f.settlementService.settle(a.id)).status, 'TAMPERED');
    assert.deepEqual(await finances(f), before);
  });
  test(`snapshot substitution ${anchored ? 'after' : 'before'} anchoring is detected without any transfer`, async t => {
    const f = await fixture(t); const a = await f.expiredAuction(); if (!anchored) f.heads.clear();
    const before = await finances(f);
    await f.pool.query('UPDATE product_snapshots SET title=$1 WHERE id=$2', ['Altered item', a.productSnapshotId]);
    assert.equal((await f.verifier.verify(a.id)).status, 'TAMPERED');
    assert.equal((await f.settlementService.settle(a.id)).status, 'TAMPERED');
    assert.deepEqual(await finances(f), before);
  });
}
test('legitimate bound settlement retries conserve funds and receipt rejects later product changes', async t => {
  const f = await fixture(t); const a = await f.expiredAuction();
  const before = await f.verifier.verify(a.id);
  assert.equal(before.status, 'VERIFIED'); assert.equal(before.integrityCoverage, 'SELLER_PRODUCT_V2');
  const results = await Promise.all(Array.from({ length: 4 }, () => f.settlementService.settle(a.id)));
  assert.ok(results.every(r => r.status === 'SETTLED' && r.settlementId === results[0].settlementId));
  await f.anchor(a.id);
  const receipt = await f.receipts.get(a.id); assert.equal(receipt.integrityCoverage, 'SELLER_PRODUCT_V2');
  const initial = await finances(f);
  const original = (await f.pool.query('SELECT title,description,image_url,source,external_id,attributes FROM product_snapshots WHERE id=$1', [a.productSnapshotId])).rows[0];
  for (const [column, value] of [['title', 'Forged'], ['description', 'Forged description'], ['image_url', 'https://example.invalid/changed'], ['source', 'other-source'], ['external_id', 'other-id'], ['attributes', JSON.stringify({ price: 1.25 })]]) {
    await f.pool.query(`UPDATE product_snapshots SET ${column}=$1 WHERE id=$2`, [value, a.productSnapshotId]);
    assert.equal((await f.verifier.verify(a.id)).status, 'TAMPERED', column);
    await assert.rejects(f.receipts.get(a.id), e => e.code === 'RECEIPT_INCONSISTENT');
    assert.deepEqual(await finances(f), initial);
    await f.pool.query(`UPDATE product_snapshots SET ${column}=$1 WHERE id=$2`, [column === 'attributes' ? JSON.stringify(original[column]) : original[column], a.productSnapshotId]);
    assert.equal((await f.verifier.verify(a.id)).status, 'VERIFIED', `restored ${column}`);
  }
  assert.equal(original.title, receipt.productSnapshot.title);
});
test('product change after external gate cannot race a valid transfer', async t => {
  const f = await fixture(t); const a = await f.expiredAuction(); const initial = await finances(f);
  const gate = { async inspect(id) {
    const proof = await f.gate.inspect(id);
    await f.pool.query('UPDATE product_snapshots SET title=$1 WHERE id=$2', ['Race mutation', a.productSnapshotId]);
    return proof;
  } };
  const result = await new SettlementService(f.settlementRepository, gate).settle(a.id);
  assert.equal(result.status, 'DEFERRED'); assert.deepEqual(await finances(f), initial);
});
test('legacy verification retains old coverage, keeps original hashes and defers unbound beneficiary capture', async t => {
  const f = await fixture(t); const a = await f.expiredAuction(); await legacyFixture(f, a.id);
  const eventsBefore = (await new DrizzleAuditRepository(f.db).snapshot(a.id)).events;
  const initial = await finances(f);
  const verification = await f.verifier.verify(a.id);
  assert.equal(verification.status, 'VERIFIED'); assert.equal(verification.integrityCoverage, 'LEGACY_V1');
  const result = await f.settlementService.settle(a.id);
  assert.equal(result.status, 'DEFERRED'); assert.equal(result.reason, 'LEGACY_INTEGRITY_UNBOUND');
  assert.deepEqual(await finances(f), initial);
  assert.deepEqual((await new DrizzleAuditRepository(f.db).snapshot(a.id)).events, eventsBefore);
});
test('verified legacy auction without bids still closes without a financial transfer or version upgrade', async t => {
  const f = await fixture(t); const a = await f.expiredAuction(false); await legacyFixture(f, a.id);
  const initial = await finances(f);
  assert.equal((await f.settlementService.settle(a.id)).status, 'CLOSED_NO_BIDS');
  assert.deepEqual(await finances(f), initial);
  const events = (await new DrizzleAuditRepository(f.db).snapshot(a.id)).events;
  assert.ok(events.every(e => e.hashVersion === 1)); assert.equal(events.at(-1).eventType, 'AUCTION_CLOSED_NO_BIDS');
});
test('already settled legacy receipts remain readable without retroactive seller/product guarantees', async t => {
  const f = await fixture(t); const a = await f.expiredAuction();
  assert.equal((await f.settlementService.settle(a.id)).status, 'SETTLED');
  await legacyFixture(f, a.id); const initial = await finances(f);
  const receipt = await f.receipts.get(a.id);
  assert.equal(receipt.integrityCoverage, 'LEGACY_V1'); assert.equal(receipt.amountCents, '100');
  await f.pool.query('UPDATE product_snapshots SET title=$1 WHERE id=$2', ['Legacy unbound item', a.productSnapshotId]);
  assert.equal((await f.receipts.get(a.id)).integrityCoverage, 'LEGACY_V1');
  assert.equal((await f.verifier.verify(a.id)).integrityCoverage, 'LEGACY_V1');
  assert.deepEqual(await finances(f), initial);
});
test('downgrading v2 genesis metadata does not bypass receipt integrity validation', async t => {
  const f = await fixture(t); const a = await f.expiredAuction();
  assert.equal((await f.settlementService.settle(a.id)).status, 'SETTLED');
  const initial = await finances(f);
  await f.pool.query('UPDATE audit_events SET hash_version=1 WHERE auction_id=$1 AND sequence=1', [a.id]);
  await f.pool.query('UPDATE product_snapshots SET title=$1 WHERE id=$2', ['Downgraded forged receipt', a.productSnapshotId]);
  await assert.rejects(f.receipts.get(a.id), e => e.code === 'RECEIPT_INCONSISTENT');
  assert.deepEqual(await finances(f), initial);
});
test('rehashing a substituted seller binding cannot overwrite its independently anchored original', async t => {
  const f = await fixture(t); const a = await f.expiredAuction(); const other = await alternateSeller(f);
  const initial = await finances(f); const originalHead = await f.external.latest(a.id);
  const repository = new DrizzleAuditRepository(f.db);
  const { events } = await repository.snapshot(a.id);
  await f.pool.query('UPDATE auctions SET auctioneer_id=$1 WHERE id=$2', [other, a.id]);
  const forgedBinding = await f.db.transaction(tx => readAuctionBinding(tx, a.id));
  let previousHash = GENESIS_HASH;
  for (const record of events) {
    const unsigned = { ...record, previousHash }; delete unsigned.eventHash;
    if (unsigned.eventType === 'AUCTION_CREATED') unsigned.payload = { ...unsigned.payload, binding: forgedBinding };
    previousHash = hashEvent(unsigned);
    await f.pool.query('UPDATE audit_events SET payload=$1,previous_hash=$2,event_hash=$3 WHERE id=$4', [JSON.stringify(unsigned.payload), unsigned.previousHash, previousHash, record.id]);
  }
  const result = await f.verifier.verify(a.id);
  assert.equal(result.status, 'TAMPERED'); assert.equal(result.reason, 'EXTERNAL_ANCHOR_MISMATCH');
  assert.equal((await f.settlementService.settle(a.id)).status, 'TAMPERED');
  assert.deepEqual(await f.external.latest(a.id), originalHead); assert.deepEqual(await finances(f), initial);
});
test('creation locks product content before any insert or response snapshot read', async t => {
  const f = await fixture(t);
  const base = new DrizzleAuctionRepository(f.db, tx => new DrizzleAuditAppender(tx));
  let release, reached;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const repository = { transaction: work => base.transaction(tx => work({ ...tx, async snapshotExists(id) {
    const exists = await tx.snapshotExists(id); reached(); await barrier; return exists;
  } })) };
  const productId = (await f.pool.query('SELECT id FROM product_snapshots LIMIT 1')).rows[0].id;
  const now = await f.clock();
  const pending = new AuctionService(repository).create(f.users.auctioneer, { productSnapshotId: productId, startingBidCents: 100n, minIncrementCents: 10n, startsAt: new Date(+now + 60000), endsAt: new Date(+now + 120000) });
  await ready;
  const pid = (await f.pool.query("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.relation='product_snapshots'::regclass AND l.mode='RowShareLock' AND a.state='idle in transaction' LIMIT 1")).rows[0].pid;
  const update = f.pool.query('UPDATE product_snapshots SET title=$1 WHERE id=$2', ['Changed after creation lock', productId]);
  try { await waitBlocked(f.pool, pid); } finally { release(); }
  const created = await pending; await update;
  assert.equal(created.productSnapshot.title, 'Bid item');
  assert.equal((await f.verifier.verify(created.id)).status, 'TAMPERED');
});
test('submillisecond captured timestamp mutation is visible to the product commitment', async t => {
  const f = await fixture(t); const a = await f.expiredAuction(); const initial = await finances(f);
  await f.pool.query("UPDATE product_snapshots SET captured_at=captured_at+interval '1 microsecond' WHERE id=$1", [a.productSnapshotId]);
  assert.equal((await f.verifier.verify(a.id)).status, 'TAMPERED');
  assert.equal((await f.settlementService.settle(a.id)).status, 'TAMPERED');
  assert.deepEqual(await finances(f), initial);
});
test('product SHARE lock is retained through capture and blocks concurrent snapshot writes', async t => {
  const f = await fixture(t); const a = await f.expiredAuction();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  let reached;
  const atCapture = new Promise(resolve => { reached = resolve; });
  const repository = { terminal: id => f.settlementRepository.terminal(id), transaction: work => f.settlementRepository.transaction(tx => work({
    ...tx, async capture(...args) { reached(); await barrier; return tx.capture(...args); },
  })) };
  const pending = new SettlementService(repository, f.gate).settle(a.id);
  await atCapture;
  const blockedWrite = f.pool.query('UPDATE product_snapshots SET title=$1 WHERE id=$2', ['Changed after settlement', a.productSnapshotId]);
  try {
    const row = (await f.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%audit_events%' AND pid<>pg_backend_pid() LIMIT 1")).rows[0];
    // Find our blocking transaction by its product lock, without relying on query text timing.
    const locks = (await f.pool.query("SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE l.relation='product_snapshots'::regclass AND l.mode='RowShareLock' AND a.state='idle in transaction'")).rows;
    const pid = locks[0]?.pid ?? row?.pid;
    assert.ok(pid); await waitBlocked(f.pool, pid);
  } finally { release(); }
  assert.equal((await pending).status, 'SETTLED'); await blockedWrite;
  await assert.rejects(f.receipts.get(a.id), e => e.code === 'RECEIPT_INCONSISTENT');
  const state = await finances(f); assert.equal(state.settlements.length, 1);
  assert.ok(state.reservations.every(r => r.status === 'CAPTURED'));
});
for (const legacy of [false, true]) test(`${legacy ? 'legacy v1' : 'v2'} commitment survives genuine signed witness outage/restart and returns original hash`, async t => {
  const f = await fixture(t); const a = await f.expiredAuction();
  if (legacy) await legacyFixture(f, a.id);
  const directory = await mkdtemp(join(tmpdir(), 'verzel-binding-'));
  const keys = generateKeyPairSync('ed25519');
  const options = { namespace: 'binding-tests', journalPath: join(directory, 'journal.jsonl'), privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publishToken: 'binding-test-publisher-secret' };
  let witness, http;
  t.after(async () => { await http?.close(); await witness?.close(); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    witness = await createWitnessServer(options); http = await serve(witness.app);
    return new HttpAnchorProvider({ baseUrl: http.url, namespace: options.namespace, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), publishToken: options.publishToken });
  }
  let external = await start(); const repository = new DrizzleAuditRepository(f.db);
  assert.equal((await new AnchorWorker(repository, external).runOnce()).failed, 0);
  const head = await external.latest(a.id);
  assert.equal((await new AuditVerifier(repository, external).verify(a.id)).integrityCoverage, legacy ? 'LEGACY_V1' : 'SELLER_PRODUCT_V2');
  await http.close(); http = undefined; await witness.close(); witness = undefined;
  assert.equal((await new AuditVerifier(repository, external).verify(a.id)).status, 'VERIFICATION_UNAVAILABLE');
  external = await start(); assert.deepEqual(await external.latest(a.id), head);
  const service = new SettlementService(f.settlementRepository, new DrizzleSettlementAuditGate(f.db, external));
  const initial = await finances(f);
  assert.equal((await service.settle(a.id)).status, legacy ? 'DEFERRED' : 'SETTLED');
  if (legacy) {
    assert.deepEqual(await finances(f), initial);
    assert.deepEqual(await external.latest(a.id), head);
    assert.equal((await new AuditVerifier(repository, external).verify(a.id)).status, 'VERIFIED');
  }
  assert.equal((await new AnchorWorker(repository, external).runOnce()).failed, 0);
});
