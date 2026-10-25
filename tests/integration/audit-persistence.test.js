import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { isolatedDatabase } from '../helpers/database.js';

let f;
let DrizzleAuditAppender;
let DrizzleAuditRepository;
let repository;
let auctionId;
const ownerId = randomUUID();
const bidderId = randomUUID();
const snapshotId = randomUUID();
const createdAt = '2026-10-24T12:00:00.000Z';
const commitment = { productSnapshotId: snapshotId, startingBidCents: '1000', minIncrementCents: '100',
  startsAt: createdAt, endsAt: '2026-10-24T13:00:00.000Z', status: 'PUBLISHED', currentBidId: null };

before(async () => {
  ({ DrizzleAuditAppender } = await import('../../src/modules/audit/repositories/drizzle-audit-appender.ts'));
  ({ DrizzleAuditRepository } = await import('../../src/modules/audit/repositories/drizzle-audit-repository.ts'));
  f = await isolatedDatabase();
  repository = new DrizzleAuditRepository(f.db);
  await f.pool.query("INSERT INTO users (id,email,password_hash,display_name,role,created_at,updated_at) VALUES ($1,'owner@private.test','secret','Owner','AUCTIONEER',now(),now()),($2,'bidder@private.test','secret','Bidder','BIDDER',now(),now())", [ownerId, bidderId]);
  await f.pool.query("INSERT INTO product_snapshots (id,external_id,source,title,captured_at) VALUES ($1,'1','test','Product',now())", [snapshotId]);
});
beforeEach(async () => {
  await f.pool.query('TRUNCATE audit_anchors, audit_events, auction_settlements, ledger_entries, ledger_transactions, bids, auctions CASCADE');
  auctionId = randomUUID();
  await f.pool.query("INSERT INTO auctions (id,auctioneer_id,product_snapshot_id,starting_bid_cents,min_increment_cents,starts_at,ends_at,status,created_at,updated_at) VALUES ($1,$2,$3,1000,100,$4,$5,'PUBLISHED',$4,$4)", [auctionId, ownerId, snapshotId, createdAt, commitment.endsAt]);
});
after(async () => { await f?.close(); });

function input(eventType = 'AUCTION_CREATED', payload = commitment) { return { auctionId, eventType, payload, createdAt }; }
function append(value = input()) { return f.db.transaction((tx) => new DrizzleAuditAppender(tx).append(value)); }

test('quarantine persists evidence, excludes only that checkpoint and refuses stale identity or confirmation', async () => {
  await append();
  const [pending] = await repository.pending(1);
  await assert.rejects(repository.quarantine({ ...pending, hash: 'f'.repeat(64) }, 'CORRUPT_RECORD'), /conflict/i);
  assert.equal((await repository.pending(1)).length, 1);
  await repository.quarantine(pending, 'INTEGRITY_CHECK_FAILED');
  await repository.quarantine(pending, 'INTEGRITY_CHECK_FAILED');
  assert.deepEqual(await new DrizzleAuditRepository(f.db).pending(1), []);
  const row = (await f.pool.query('SELECT * FROM audit_anchors WHERE id=$1', [pending.id])).rows[0];
  assert.equal(row.blocked_reason, 'INTEGRITY_CHECK_FAILED');
  assert.ok(row.blocked_at);
  assert.equal(row.external_reference, null);
  assert.equal(row.last_hash, pending.hash);
  assert.equal((await repository.snapshot(auctionId)).events.length, 1);
  await assert.rejects(repository.confirm(pending.id, 'false-proof', createdAt, pending), /conflict/i);
});

test('confirmation rejects a checkpoint changed after the worker read its pending row', async () => {
  await append();
  const [pending] = await repository.pending(1);
  await f.pool.query('UPDATE audit_anchors SET last_hash=$1 WHERE id=$2', ['f'.repeat(64), pending.id]);
  await assert.rejects(repository.confirm(pending.id, 'witness:1', createdAt, pending), /conflict/i);
  assert.equal((await repository.pending(1)).length, 1);
});

test('caller rollback removes business mutation, event and outbox checkpoint together', async () => {
  await assert.rejects(f.db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE auctions SET starting_bid_cents = 5000 WHERE id = ${auctionId}`);
    await new DrizzleAuditAppender(tx).append(input('AUCTION_CREATED', { ...commitment, startingBidCents: '5000' }));
    throw new Error('rollback');
  }), /rollback/);
  assert.equal((await f.pool.query('SELECT starting_bid_cents FROM auctions')).rows[0].starting_bid_cents, '1000');
  assert.equal((await repository.snapshot(auctionId)).events.length, 0);
  assert.deepEqual(await repository.pending(10), []);
});

test('concurrent appends serialize under the parent auction lock with contiguous hashes', async () => {
  await append();
  await Promise.all(Array.from({ length: 8 }, () => append(input('AUCTION_UPDATED'))));
  const snapshot = await repository.snapshot(auctionId);
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n]);
  assert.equal(snapshot.events[0].previousHash, '0'.repeat(64));
  for (let index = 1; index < snapshot.events.length; index++) {
    assert.equal(snapshot.events[index].previousHash, snapshot.events[index - 1].eventHash);
  }
  assert.equal(new Set(snapshot.events.map((event) => event.id)).size, 9);
  assert.equal(snapshot.events[0].hashVersion, 2);
  assert.equal(snapshot.events[0].createdAt, createdAt);
  assert.equal((await repository.pending(20)).length, 9);
  assert.deepEqual((await repository.page(auctionId, 3n, 2)).map((event) => event.sequence), [4n, 5n]);
});

test('pending checkpoints survive and confirmation is immutable and idempotent', async () => {
  const first = await append();
  await append(input('AUCTION_UPDATED'));
  const pending = await new DrizzleAuditRepository(f.db).pending(1);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sequence, 1n);
  assert.equal(pending[0].hash, first.eventHash);
  await repository.confirm(pending[0].id, 'witness:1', createdAt);
  await repository.confirm(pending[0].id, 'witness:1', '2026-10-24T12:01:00.000Z');
  await assert.rejects(repository.confirm(pending[0].id, 'witness:forged', createdAt), /conflict/i);
  const row = (await f.pool.query("SELECT external_reference, anchored_at AT TIME ZONE 'UTC' AS anchored_at FROM audit_anchors WHERE id=$1", [pending[0].id])).rows[0];
  assert.equal(row.external_reference, 'witness:1');
  assert.equal(row.anchored_at.toISOString(), createdAt);
  assert.deepEqual((await repository.pending(10)).map((item) => item.sequence), [2n]);
});

test('concurrent conflicting confirmations cannot overwrite the winning reference', async () => {
  await append();
  const [pending] = await repository.pending(1);
  const results = await Promise.allSettled(['witness:a', 'witness:b'].map((reference) => repository.confirm(pending.id, reference, createdAt)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('invalid input and corrupted existing chains cannot append another event', async () => {
  await assert.rejects(append(input('AUCTION_CREATED', { ...commitment, email: 'private@test.com' })));
  await append();
  await f.pool.query("UPDATE audit_events SET event_hash = repeat('f',64)");
  await assert.rejects(append(input('AUCTION_UPDATED')), /chain/i);
  assert.equal((await f.pool.query('SELECT count(*) FROM audit_events')).rows[0].count, '1');
  assert.equal((await repository.pending(10)).length, 1);
});

test('operational commitments contain pseudonymous bids and a hashed receipt only', async () => {
  const bidId = randomUUID();
  const settlementId = randomUUID();
  const ledgerId = randomUUID();
  const receiptToken = randomUUID();
  await f.pool.query('INSERT INTO bids (id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES ($1,$2,$3,1200,1,$4)', [bidId, auctionId, bidderId, createdAt]);
  await f.pool.query("INSERT INTO ledger_transactions (id,type,idempotency_key,created_at) VALUES ($1,'AUCTION_SETTLEMENT',$3,$2)", [ledgerId, createdAt, ledgerId]);
  await f.pool.query('INSERT INTO auction_settlements (id,auction_id,winning_bid_id,ledger_transaction_id,amount_cents,receipt_token,settled_at) VALUES ($1,$2,$3,$4,1200,$5,$6)', [settlementId, auctionId, bidId, ledgerId, receiptToken, createdAt]);
  await f.pool.query("UPDATE auctions SET current_bid_id=$1,status='SETTLED' WHERE id=$2", [bidId, auctionId]);
  const { operational } = await repository.snapshot(auctionId);
  assert.equal(operational.auction.currentBidId, bidId);
  assert.equal(operational.auction.status, 'SETTLED');
  assert.equal(operational.bids[0].bidId, bidId);
  assert.equal(operational.bids[0].amountCents, '1200');
  assert.match(operational.bids[0].bidderRef, /^[a-f0-9]{64}$/);
  assert.equal(operational.settlement.receiptHash, createHash('sha256').update(receiptToken).digest('hex'));
  const serialized = JSON.stringify(operational);
  for (const secret of [ownerId, bidderId, receiptToken, 'private.test', 'passwordHash', 'receiptToken', 'bidderId']) assert.equal(serialized.includes(secret), false);
  assert.equal(await repository.snapshot(randomUUID()), null);
});

test('snapshot rejects an oversized history instead of exposing a partial verified prefix', async () => {
  await append();
  await f.pool.query('INSERT INTO audit_events (id,auction_id,sequence,event_type,payload,previous_hash,event_hash,created_at,hash_version) SELECT gen_random_uuid(),auction_id,n,event_type,payload,previous_hash,event_hash,created_at,hash_version FROM audit_events CROSS JOIN generate_series(2,10002) AS n');
  await assert.rejects(repository.snapshot(auctionId), /limit|large|10000/i);
  const { AnchorWorker } = await import('../../src/modules/audit/services/anchor-worker.ts');
  const worker = new AnchorWorker(repository, { latest: async () => null, publish: async () => { throw new Error('must not publish'); } });
  assert.deepEqual(await worker.runOnce(), { confirmed: 0, failed: 0, blocked: 1 });
  assert.deepEqual(await repository.pending(1), []);
});

test('snapshot keeps auction, bids and events at one repeatable read point during a concurrent commit', async () => {
  await append();
  const client = await f.pool.connect();
  let reading;
  try {
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await client.query('LOCK TABLE bids IN ACCESS EXCLUSIVE MODE');
    await client.query('UPDATE auctions SET starting_bid_cents=5000 WHERE id=$1', [auctionId]);
    await client.query('INSERT INTO bids (id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES ($1,$2,$3,6000,1,$4)', [randomUUID(), auctionId, bidderId, createdAt]);
    await client.query('INSERT INTO audit_events (id,auction_id,sequence,event_type,payload,previous_hash,event_hash,created_at,hash_version) SELECT gen_random_uuid(),auction_id,2,event_type,payload,previous_hash,event_hash,created_at,hash_version FROM audit_events');
    reading = repository.snapshot(auctionId);
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const result = await f.pool.query('SELECT count(*) FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))', [pid]);
      if (Number(result.rows[0].count) > 0) { blocked = true; break; }
      await setTimeout(20);
    }
    assert.ok(blocked, 'snapshot must have read the auction before waiting for bids');
    await client.query('COMMIT');
    const snapshot = await reading;
    assert.equal(snapshot.operational.auction.startingBidCents, '1000');
    assert.equal(snapshot.operational.bids.length, 0);
    assert.equal(snapshot.events.length, 1);
    assert.equal((await repository.snapshot(auctionId)).events.length, 2);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await reading;
  }
});
