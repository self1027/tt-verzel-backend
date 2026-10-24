import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';
import { DrizzleReservationOperations } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';

let f, reservation, recipientWalletId, winnerWalletId, auctionId;
const operations = new DrizzleReservationOperations();
before(async () => { f = await bidFixture(); });
after(async () => { await f?.close(); });
beforeEach(async () => {
  await f.reset();
  await f.deposit('bidder1', '1000');
  const auction = await f.createAuction();
  auctionId = auction.id;
  const bidId = randomUUID();
  await f.pool.query('INSERT INTO bids(id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES($1,$2,$3,400,1,now())', [bidId, auctionId, f.users.bidder1]);
  const rows = (await f.pool.query('SELECT id,user_id FROM wallets')).rows;
  winnerWalletId = rows.find(row => row.user_id === f.users.bidder1).id;
  recipientWalletId = rows.find(row => row.user_id === f.users.auctioneer).id;
  reservation = await f.db.transaction(tx => operations.reserveFunds(tx, { walletId: winnerWalletId, auctionId, bidId, amountCents: 400n }));
});
function capture(overrides = {}) {
  return f.db.transaction(tx => operations.captureReservation(tx, {
    reservationId: reservation.id, recipientWalletId, idempotencyKey: `settlement:${auctionId}`, ...overrides,
  }));
}
async function balances() {
  return (await f.pool.query('SELECT user_id,balance_cents,reserved_cents FROM wallets ORDER BY user_id')).rows;
}
async function transfers() {
  return (await f.pool.query("SELECT t.idempotency_key,t.reference_id,e.account_id,e.amount_cents FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id WHERE t.type='AUCTION_SETTLEMENT' ORDER BY e.amount_cents")).rows;
}

test('capture conserves exact funds with a paired ledger transfer and concurrent retries', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => capture()));
  results.forEach(row => assert.deepEqual(row, results[0]));
  assert.equal(results[0].status, 'CAPTURED');
  assert.equal(results[0].releasedAt, null);
  const rows = await balances();
  assert.equal(rows.find(row => row.user_id === f.users.bidder1).balance_cents, '600');
  assert.equal(rows.find(row => row.user_id === f.users.bidder1).reserved_cents, '0');
  assert.equal(rows.find(row => row.user_id === f.users.auctioneer).balance_cents, '400');
  const entries = await transfers();
  assert.deepEqual(entries.map(row => row.amount_cents).sort(), ['-400', '400']);
  entries.forEach(row => {
    assert.equal(row.idempotency_key, `settlement:${auctionId}`);
    assert.equal(row.reference_id, reservation.id);
  });
  await assert.rejects(f.db.transaction(tx => operations.releaseReservation(tx, reservation.id)), { code: 'RESERVATION_CONFLICT' });
});

test('capture writes all roll back with its caller transaction', async () => {
  const original = await balances();
  await assert.rejects(f.db.transaction(async tx => {
    await operations.captureReservation(tx, { reservationId: reservation.id, recipientWalletId, idempotencyKey: `settlement:${auctionId}` });
    throw new Error('caller rollback');
  }), /caller rollback/);
  assert.deepEqual(await balances(), original);
  assert.deepEqual(await transfers(), []);
  assert.equal((await f.pool.query('SELECT status FROM wallet_reservations WHERE id=$1', [reservation.id])).rows[0].status, 'ACTIVE');
});

test('terminal capture binds the original key, recipient and exact ledger entries', async () => {
  await capture();
  await assert.rejects(capture({ idempotencyKey: 'different' }), { code: 'RESERVATION_CONFLICT' });
  await assert.rejects(capture({ recipientWalletId: winnerWalletId }), { code: 'RESERVATION_CONFLICT' });
  await f.pool.query("UPDATE ledger_transactions SET reference_id=$1 WHERE type='AUCTION_SETTLEMENT'", [randomUUID()]);
  await assert.rejects(capture(), { code: 'RESERVATION_CONFLICT' });
});

test('capture rejects released reservations and keys already bound to another transfer', async () => {
  await assert.rejects(capture({ idempotencyKey: (await f.pool.query("SELECT idempotency_key FROM ledger_transactions WHERE type='DEPOSIT'")).rows[0].idempotency_key }), { code: 'RESERVATION_CONFLICT' });
  await f.db.transaction(tx => operations.releaseReservation(tx, reservation.id));
  await assert.rejects(capture(), { code: 'RESERVATION_CONFLICT' });
  assert.deepEqual(await transfers(), []);
});

test('captured retries reject changed amount even when bid and reservation agree', async () => {
  await capture();
  await f.pool.query('UPDATE bids SET amount_cents=401 WHERE id=$1', [reservation.bidId]);
  await f.pool.query('UPDATE wallet_reservations SET amount_cents=401 WHERE id=$1', [reservation.id]);
  await assert.rejects(capture(), { code: 'RESERVATION_CONFLICT' });
});

test('capture rejects invalid keys and inconsistent reservation amount', async () => {
  for (const idempotencyKey of ['', 'with spaces', 'x'.repeat(256)]) {
    await assert.rejects(capture({ idempotencyKey }), { code: 'INVALID_IDEMPOTENCY_KEY' });
  }
  await f.pool.query('UPDATE wallet_reservations SET amount_cents=0 WHERE id=$1', [reservation.id]);
  await assert.rejects(capture(), { code: 'INVALID_WALLET_STATE' });
  assert.deepEqual(await transfers(), []);
});

test('capture rejects inconsistent balances and active reservation sums without moving funds', async () => {
  for (const [id, balance, reserved] of [[winnerWalletId, '999', '400'], [winnerWalletId, '399', '400'], [winnerWalletId, '1000', '399'], [recipientWalletId, '1', '0']]) {
    await f.pool.query('UPDATE wallets SET balance_cents=$1,reserved_cents=$2 WHERE id=$3', [balance, reserved, id]);
    await assert.rejects(capture(), { code: 'INVALID_WALLET_STATE' });
    await f.pool.query('UPDATE wallets SET balance_cents=$1,reserved_cents=$2 WHERE id=$3', [id === winnerWalletId ? '1000' : '0', id === winnerWalletId ? '400' : '0', id]);
  }
  assert.deepEqual(await transfers(), []);
});

test('capture validates bidder identity, seller recipient and both roles', async () => {
  const other = (await f.pool.query('SELECT id FROM wallets WHERE user_id=$1', [f.users.bidder2])).rows[0].id;
  await assert.rejects(capture({ recipientWalletId: other }), { code: 'RESERVATION_CONFLICT' });
  for (const [id, role] of [[f.users.bidder1, 'AUCTIONEER'], [f.users.auctioneer, 'BIDDER']]) {
    await f.pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
    await assert.rejects(capture(), { code: 'RESERVATION_CONFLICT' });
    await f.pool.query('UPDATE users SET role=$1 WHERE id=$2', [role === 'BIDDER' ? 'AUCTIONEER' : 'BIDDER', id]);
  }
  await f.pool.query('UPDATE bids SET bidder_id=$1 WHERE id=$2', [f.users.bidder2, reservation.bidId]);
  await assert.rejects(capture(), { code: 'RESERVATION_CONFLICT' });
});

test('capture rejects recipient BIGINT overflow with reconciled ledger funds', async () => {
  const accountId = (await f.pool.query('SELECT id FROM ledger_accounts WHERE wallet_id=$1', [recipientWalletId])).rows[0].id;
  const clearingId = (await f.pool.query("SELECT id FROM ledger_accounts WHERE type='SIMULATION_CLEARING'")).rows[0].id;
  const id = randomUUID();
  await f.pool.query("INSERT INTO ledger_transactions(id,type,idempotency_key,created_at) VALUES($1,'DEPOSIT',$2,now())", [id, randomUUID()]);
  await f.pool.query('INSERT INTO ledger_entries(id,transaction_id,account_id,amount_cents,created_at) VALUES($1,$2,$3,9223372036854775807,now()),($4,$2,$5,-9223372036854775807,now())', [randomUUID(), id, accountId, randomUUID(), clearingId]);
  await f.pool.query('UPDATE wallets SET balance_cents=9223372036854775807 WHERE id=$1', [recipientWalletId]);
  await assert.rejects(capture(), { code: 'INVALID_WALLET_STATE' });
  assert.deepEqual(await transfers(), []);
});
