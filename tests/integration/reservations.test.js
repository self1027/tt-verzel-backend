import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { isolatedDatabase, seedConfig } from '../helpers/database.js';
import { seed } from '../../src/shared/database/seed.ts';
import { DrizzleReservationOperations, lockReservationWallets } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';

let database, bidder, other, owner, snapshot, walletId, auctionId, bidId;
const operations = new DrizzleReservationOperations();
before(async () => {
  database = await isolatedDatabase();
  await seed(database.db, seedConfig);
  const users = (await database.pool.query('SELECT id,email FROM users')).rows;
  bidder = users.find((u) => u.email === 'bidder1@verzel.local').id;
  other = users.find((u) => u.email === 'bidder2@verzel.local').id;
  owner = users.find((u) => u.email === 'auctioneer@verzel.local').id;
  walletId = (await database.pool.query('SELECT id FROM wallets WHERE user_id=$1', [bidder])).rows[0].id;
  snapshot = randomUUID();
  await database.pool.query("INSERT INTO product_snapshots (id,external_id,source,title,attributes,captured_at) VALUES ($1,'1','test','Test','{}',now())", [snapshot]);
});
beforeEach(async () => {
  await database.pool.query('DELETE FROM wallet_reservations; UPDATE auctions SET current_bid_id=NULL; DELETE FROM bids; DELETE FROM auctions; UPDATE wallets SET balance_cents=100,reserved_cents=0');
  auctionId = randomUUID();
  await database.pool.query("INSERT INTO auctions (id,auctioneer_id,product_snapshot_id,starting_bid_cents,min_increment_cents,starts_at,ends_at,status,created_at,updated_at) VALUES ($1,$2,$3,1,1,now(),now()+interval '1 hour','PUBLISHED',now(),now())", [auctionId, owner, snapshot]);
  bidId = await addBid();
});
after(async () => { await database?.close(); });
async function addBid(user = bidder, amount = '40') {
  const id = randomUUID();
  await database.pool.query('INSERT INTO bids (id,auction_id,bidder_id,amount_cents,sequence,created_at) SELECT $1,$2,$3,$4,count(*)+1,now() FROM bids WHERE auction_id=$2', [id, auctionId, user, amount]);
  return id;
}
function reserve(overrides = {}) {
  return database.db.transaction((tx) => operations.reserveFunds(tx, { walletId, auctionId, bidId, amountCents: 40n, ...overrides }));
}
function release(id) { return database.db.transaction((tx) => operations.releaseReservation(tx, id)); }
async function state() {
  return (await database.pool.query('SELECT balance_cents,reserved_cents,(SELECT count(*) FROM ledger_transactions) AS ledger FROM wallets WHERE id=$1', [walletId])).rows[0];
}

test('reserve and release change reserved once, persist original retries and never touch ledger or balance', async () => {
  const original = await reserve();
  assert.equal(original.status, 'ACTIVE');
  assert.deepEqual(await reserve(), original);
  assert.deepEqual(await state(), { balance_cents: '100', reserved_cents: '40', ledger: '0' });
  const released = await release(original.id);
  assert.equal(released.status, 'RELEASED');
  assert.ok(released.releasedAt instanceof Date);
  assert.deepEqual(await release(original.id), released);
  assert.deepEqual(await state(), { balance_cents: '100', reserved_cents: '0', ledger: '0' });
  await assert.rejects(reserve(), { code: 'RESERVATION_CONFLICT' });
});

test('reserve rejects invalid amounts, mismatched identities and auctioneer funds', async () => {
  for (const amountCents of [0n, -1n, 9223372036854775808n]) {
    await assert.rejects(reserve({ amountCents }), { code: 'INVALID_RESERVATION_AMOUNT' });
  }
  await assert.rejects(reserve({ amountCents: 41n }), { code: 'RESERVATION_MISMATCH' });
  const foreignBid = await addBid(other);
  await assert.rejects(reserve({ bidId: foreignBid }), { code: 'RESERVATION_MISMATCH' });
  const ownBid = await addBid(owner);
  const ownerWallet = (await database.pool.query('SELECT id FROM wallets WHERE user_id=$1', [owner])).rows[0].id;
  await assert.rejects(reserve({ walletId: ownerWallet, bidId: ownBid }), { code: 'BIDDER_REQUIRED' });
  assert.equal((await state()).reserved_cents, '0');
});

test('reserve rejects insufficient available funds and a second active bid in an auction', async () => {
  await reserve();
  const second = await addBid();
  await assert.rejects(reserve({ bidId: second }), { code: 'RESERVATION_CONFLICT' });
  await database.pool.query('UPDATE wallets SET balance_cents=39,reserved_cents=0 WHERE id=$1', [walletId]);
  await database.pool.query('DELETE FROM wallet_reservations');
  await assert.rejects(reserve(), { code: 'INSUFFICIENT_FUNDS' });
});

test('wallet locks reject stored financial corruption and mismatched active reservation sums', async () => {
  for (const [balance, reserved] of [['-1','0'], ['100','-1'], ['100','101'], ['100','1']]) {
    await database.pool.query('UPDATE wallets SET balance_cents=$1,reserved_cents=$2 WHERE id=$3', [balance, reserved, walletId]);
    await assert.rejects(database.db.transaction((tx) => lockReservationWallets(tx, [walletId])), { code: 'INVALID_WALLET_STATE' });
  }
  await database.pool.query('UPDATE wallets SET balance_cents=100,reserved_cents=0 WHERE id=$1', [walletId]);
  const row = await reserve();
  await database.pool.query('UPDATE wallet_reservations SET amount_cents=-40 WHERE id=$1', [row.id]);
  await assert.rejects(release(row.id), { code: 'INVALID_WALLET_STATE' });
});

test('caller rollback restores both reservation transition and reserved balance', async () => {
  await assert.rejects(database.db.transaction(async (tx) => {
    await operations.reserveFunds(tx, { walletId, auctionId, bidId, amountCents: 40n });
    throw new Error('caller rollback');
  }), /caller rollback/);
  assert.equal((await state()).reserved_cents, '0');
  assert.equal((await database.pool.query('SELECT count(*) FROM wallet_reservations')).rows[0].count, '0');
  const row = await reserve();
  await assert.rejects(database.db.transaction(async (tx) => {
    await operations.releaseReservation(tx, row.id);
    throw new Error('caller rollback');
  }), /caller rollback/);
  assert.deepEqual(await reserve(), row);
  assert.equal((await state()).reserved_cents, '40');
});

test('captured reservations cannot be released or reserved again', async () => {
  const row = await reserve();
  await database.pool.query("UPDATE wallet_reservations SET status='CAPTURED' WHERE id=$1", [row.id]);
  await database.pool.query('UPDATE wallets SET balance_cents=60,reserved_cents=0 WHERE id=$1', [walletId]);
  await assert.rejects(release(row.id), { code: 'RESERVATION_CONFLICT' });
  await assert.rejects(reserve(), { code: 'RESERVATION_CONFLICT' });
  assert.deepEqual(await state(), { balance_cents: '60', reserved_cents: '0', ledger: '0' });
});

test('concurrent retries serialize and reserve a bid only once', async () => {
  const rows = await Promise.all(Array.from({ length: 8 }, () => reserve()));
  rows.forEach((row) => assert.deepEqual(row, rows[0]));
  assert.equal((await state()).reserved_cents, '40');
  const releases = await Promise.all(rows.map((row) => release(row.id)));
  releases.forEach((row) => assert.deepEqual(row, releases[0]));
  assert.equal((await state()).reserved_cents, '0');
});

test('available funds include reservations in other auctions', async () => {
  await reserve();
  const nextAuction = randomUUID(), nextBid = randomUUID();
  await database.pool.query('INSERT INTO auctions SELECT $1,auctioneer_id,product_snapshot_id,NULL,starting_bid_cents,min_increment_cents,starts_at,ends_at,status,created_at,updated_at FROM auctions WHERE id=$2', [nextAuction, auctionId]);
  await database.pool.query('INSERT INTO bids (id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES ($1,$2,$3,61,1,now())', [nextBid, nextAuction, bidder]);
  await assert.rejects(reserve({ auctionId: nextAuction, bidId: nextBid, amountCents: 61n }), { code: 'INSUFFICIENT_FUNDS' });
  await database.pool.query('UPDATE bids SET amount_cents=60 WHERE id=$1', [nextBid]);
  const next = await reserve({ auctionId: nextAuction, bidId: nextBid, amountCents: 60n });
  assert.equal((await state()).reserved_cents, '100');
  await release(next.id);
  assert.equal((await state()).reserved_cents, '40');
});

test('BIGINT maximum reservation and release preserve exact cents', async () => {
  await database.pool.query('UPDATE wallets SET balance_cents=9223372036854775807 WHERE id=$1', [walletId]);
  await database.pool.query('UPDATE bids SET amount_cents=9223372036854775807 WHERE id=$1', [bidId]);
  const original = await reserve({ amountCents: 9223372036854775807n });
  assert.equal(original.amountCents, 9223372036854775807n);
  assert.equal((await state()).reserved_cents, '9223372036854775807');
  await release(original.id);
  assert.deepEqual(await state(), { balance_cents: '9223372036854775807', reserved_cents: '0', ledger: '0' });
});
