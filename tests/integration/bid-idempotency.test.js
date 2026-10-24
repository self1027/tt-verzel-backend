import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { isolatedDatabase } from '../helpers/database.js';
import { bidderReference } from '../../src/modules/audit/domain/cryptography.ts';
import { bidFingerprint } from '../../src/modules/bids/domain/idempotency.ts';
import { DrizzleBidOperationStore } from '../../src/modules/bids/repositories/drizzle-bid-operation-store.ts';

let database, auctionId;
const userId = randomUUID(), otherUserId = randomUUID(), snapshotId = randomUUID();
const createdAt = '2026-10-24T12:00:00.000Z';
before(async () => {
  database = await isolatedDatabase();
  await database.pool.query("INSERT INTO users (id,email,password_hash,display_name,role,created_at,updated_at) VALUES ($1,'one@test.local','secret','One','BIDDER',now(),now()),($2,'two@test.local','secret','Two','BIDDER',now(),now())", [userId, otherUserId]);
  await database.pool.query("INSERT INTO product_snapshots (id,external_id,source,title,captured_at) VALUES ($1,'1','test','Product',now())", [snapshotId]);
});
beforeEach(async () => {
  await database.pool.query('TRUNCATE auctions CASCADE');
  auctionId = await auction();
});
after(async () => { await database?.close(); });
async function auction() {
  const id = randomUUID();
  await database.pool.query("INSERT INTO auctions (id,auctioneer_id,product_snapshot_id,starting_bid_cents,min_increment_cents,starts_at,ends_at,status,created_at,updated_at) VALUES ($1,$2,$3,100,10,$4,'2026-10-24T13:00:00Z','PUBLISHED',$4,$4)", [id, userId, snapshotId, createdAt]);
  return id;
}
async function operation({ actor = userId, scope = auctionId, key = 'retry', sequence = '1', amount = '9007199254740993' } = {}) {
  const id = randomUUID();
  await database.pool.query('INSERT INTO bids (id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, scope, actor, amount, sequence, createdAt]);
  return { userId: actor, auctionId: scope, key, fingerprint: bidFingerprint(BigInt(amount)), result: { id, auctionId: scope, bidderRef: bidderReference(scope, actor), amountCents: amount, sequence, createdAt, endsAt: '2026-10-24T13:00:00.000Z' } };
}
function save(value) { return database.db.transaction(tx => new DrizzleBidOperationStore(tx).save(value)); }
function find(actor = userId, scope = auctionId, key = 'retry') { return database.db.transaction(tx => new DrizzleBidOperationStore(tx).find(actor, scope, key)); }

test('fingerprints bind canonical positive BIGINT amounts to versioned PlaceBid payloads', () => {
  assert.equal(bidFingerprint(9007199254740993n), createHash('sha256').update('verzel:bid:place:v1\0').update('{"amountCents":"9007199254740993"}').digest('hex'));
  assert.notEqual(bidFingerprint(1n), bidFingerprint(2n));
  for (const amount of [0n, -1n, 9223372036854775808n, '1', 1, null]) assert.throws(() => bidFingerprint(amount));
});
test('persisted receipts survive new stores and changing auction pointers, status and deadline', async () => {
  assert.equal(await find(), null);
  const original = await operation();
  await save(original);
  const next = await operation({ sequence: '2', amount: '9007199254740994' });
  await database.pool.query("UPDATE auctions SET current_bid_id=$1,status='CANCELLED',ends_at='2026-10-25T12:00:00Z' WHERE id=$2", [next.result.id, auctionId]);
  assert.deepEqual(await find(), { fingerprint: original.fingerprint, result: original.result });
  const persisted = (await database.pool.query("SELECT bid_id,created_at AT TIME ZONE 'UTC' AS created_at FROM bid_operations")).rows[0];
  assert.equal(persisted.bid_id, original.result.id);
  assert.equal(persisted.created_at.toISOString(), createdAt);
});
test('same key is independent per user and auction with no cross-scope reads', async () => {
  const secondAuction = await auction();
  const values = [await operation(), await operation({ actor: otherUserId, sequence: '2', amount: '200' }), await operation({ scope: secondAuction, amount: '300' })];
  for (const value of values) await save(value);
  for (const value of values) assert.deepEqual(await find(value.userId, value.auctionId), { fingerprint: value.fingerprint, result: value.result });
  assert.equal(await find(otherUserId, secondAuction), null);
  assert.equal(await find(userId, auctionId, 'missing'), null);
});
test('concurrent duplicate scoped keys persist exactly one immutable receipt', async () => {
  const values = [await operation(), await operation({ sequence: '2', amount: '200' })];
  let pending;
  try {
    await database.db.transaction(async tx => {
      const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      const pid = result.rows[0].pid;
      await new DrizzleBidOperationStore(tx).save(values[0]);
      pending = Promise.allSettled([save(values[1])]);
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const waiting = await database.pool.query('SELECT count(*) FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))', [pid]);
        if (waiting.rows[0].count !== '0') { blocked = true; break; }
        await setTimeout(20);
      }
      assert.ok(blocked, 'Duplicate key insert must wait for the uncommitted unique key');
    });
    const [loser] = await pending;
    assert.equal(loser.status, 'rejected');
    assert.equal(loser.reason.cause.code, '23505');
  } finally { await pending; }
  assert.equal((await database.pool.query('SELECT count(*) FROM bid_operations')).rows[0].count, '1');
  const winner = values[0];
  assert.deepEqual(await find(), { fingerprint: winner.fingerprint, result: winner.result });
});
test('one bid cannot be attached to multiple idempotency keys', async () => {
  const value = await operation();
  await save(value);
  await assert.rejects(save({ ...value, key: 'second-key' }));
  assert.equal(await find(userId, auctionId, 'second-key'), null);
});
test('caller rollback removes operation receipts and associated transaction changes', async () => {
  const value = await operation();
  await assert.rejects(database.db.transaction(async tx => {
    await new DrizzleBidOperationStore(tx).save(value);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(await find(), null);
  await save(value);
  assert.deepEqual((await find()).result, value.result);
});
test('invalid persisted receipts and scope bindings fail closed without returning hostile data', async () => {
  const value = await operation();
  await save(value);
  const mutations = [
    { id: randomUUID() }, { auctionId: randomUUID() }, { bidderRef: 'f'.repeat(64) },
    { amountCents: '01' }, { amountCents: 'secret' }, { amountCents: '9223372036854775808' }, { sequence: '0' },
    { createdAt: '2026-02-30T12:00:00.000Z' }, { endsAt: 'secret' }, { privateEmail: 'secret' },
  ];
  for (const mutation of mutations) {
    await database.pool.query('UPDATE bid_operations SET result=$1', [JSON.stringify({ ...value.result, ...mutation })]);
    await assert.rejects(find(), error => error instanceof Error && !error.message.includes('secret'));
  }
  await database.pool.query('UPDATE bid_operations SET result=$1,fingerprint=$2', [JSON.stringify(value.result), 'f'.repeat(64)]);
  await assert.rejects(find());
});
