import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { Router } from 'express';
import { bidFixture } from '../helpers/bids.js';
import { serve } from '../helpers/http.js';
import { createApp } from '../../src/app.ts';
import { createReceiptRouter } from '../../src/modules/settlements/receipt-router.ts';
import { DrizzleReservationOperations } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';
import { bidderReference, hashEvent } from '../../src/modules/audit/domain/cryptography.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';

let f, http, auction, bidId, settlementId, reservation, token;
before(async () => {
  f = await bidFixture();
  http = await serve(createApp(Router(), undefined, createReceiptRouter(f.db)));
});
after(async () => { await http?.close(); await f?.close(); });
beforeEach(async () => {
  await f.pool.query('DELETE FROM auction_settlements');
  await f.reset();
  await f.deposit('bidder1', '1000');
  auction = await f.createAuction();
  // This fixture handcrafts pre-audit financial history; keep it explicitly legacy.
  const [original] = (await new DrizzleAuditRepository(f.db).snapshot(auction.id)).events;
  const genesis = { ...original }; delete genesis.eventHash;
  const terms = { ...genesis.payload }; delete terms.binding;
  genesis.payload = terms; genesis.hashVersion = 1;
  await f.pool.query('UPDATE audit_events SET payload=$1,hash_version=1,event_hash=$2 WHERE id=$3', [JSON.stringify(terms), hashEvent(genesis), genesis.id]);
  bidId = randomUUID(); settlementId = randomUUID(); token = randomUUID();
  await f.pool.query('INSERT INTO bids(id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES($1,$2,$3,400,1,now())', [bidId, auction.id, f.users.bidder1]);
  await f.pool.query('UPDATE auctions SET current_bid_id=$1,ends_at=now()-interval \'1 second\' WHERE id=$2', [bidId, auction.id]);
  const wallets = (await f.pool.query('SELECT id,user_id FROM wallets')).rows;
  const operations = new DrizzleReservationOperations();
  reservation = await f.db.transaction(tx => operations.reserveFunds(tx, {
    walletId: wallets.find(row => row.user_id === f.users.bidder1).id, auctionId: auction.id, bidId, amountCents: 400n,
  }));
  await f.db.transaction(tx => operations.captureReservation(tx, {
    reservationId: reservation.id, recipientWalletId: wallets.find(row => row.user_id === f.users.auctioneer).id, idempotencyKey: `settlement:${auction.id}`,
  }));
  const transaction = (await f.pool.query("SELECT id FROM ledger_transactions WHERE type='AUCTION_SETTLEMENT'")).rows[0];
  await f.pool.query('INSERT INTO auction_settlements(id,auction_id,winning_bid_id,ledger_transaction_id,amount_cents,receipt_token,settled_at) VALUES($1,$2,$3,$4,400,$5,now())', [settlementId, auction.id, bidId, transaction.id, token]);
  await f.pool.query("UPDATE auctions SET status='SETTLED' WHERE id=$1", [auction.id]);
  await f.pool.query('UPDATE product_snapshots SET attributes=$1 WHERE id=$2', [JSON.stringify({ email: 'private@example.com' }), auction.productSnapshotId]);
});
function request(suffix = '', id = auction.id) { return fetch(`${http.url}/auctions/${id}/receipt${suffix}`); }

test('public receipt projects exact captured funds without private metadata', async () => {
  const response = await request('', auction.id.toUpperCase());
  assert.equal(response.status, 200);
  const { receipt } = await response.json();
  assert.equal(receipt.auctionId, auction.id);
  assert.equal(receipt.amountCents, '400');
  assert.equal(receipt.settlementId, settlementId);
  assert.deepEqual(receipt.winningBid, { id: bidId, bidderRef: bidderReference(auction.id, f.users.bidder1) });
  assert.equal(receipt.productSnapshot.id, auction.productSnapshotId);
  assert.equal(receipt.productSnapshot.title, 'Bid item');
  assert.equal(receipt.auditUrl, `/auctions/${auction.id}/audit`);
  assert.equal(receipt.receiptUrl, `/auctions/${auction.id}/receipt`);
  assert.ok(Number.isFinite(Date.parse(receipt.endsAt)));
  assert.ok(Number.isFinite(Date.parse(receipt.settledAt)));
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [token, f.users.bidder1, f.users.auctioneer, reservation.walletId, 'private@example.com', 'receiptToken', 'idempotencyKey', 'password', 'balanceCents']) assert.ok(!serialized.includes(forbidden), forbidden);
});

test('receipt is unavailable before settlement and requires strict UUID/query input', async () => {
  assert.equal((await request('?extra=1')).status, 400);
  assert.equal((await request('', 'invalid')).status, 400);
  assert.equal((await request('', randomUUID())).status, 404);
  await f.pool.query("UPDATE auctions SET status='PUBLISHED' WHERE id=$1", [auction.id]);
  let response = await request();
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'RECEIPT_NOT_AVAILABLE');
  await f.pool.query("UPDATE auctions SET status='SETTLED' WHERE id=$1", [auction.id]);
  await f.pool.query('DELETE FROM auction_settlements');
  response = await request();
  assert.equal(response.status, 404);
});

for (const [name, sql, params] of [
  ['amount mismatch', 'UPDATE auction_settlements SET amount_cents=401', () => []],
  ['current pointer mismatch', 'UPDATE auctions SET current_bid_id=NULL WHERE id=$1', () => [auction.id]],
  ['uncaptured reservation', "UPDATE wallet_reservations SET status='RELEASED'", () => []],
  ['reservation amount mismatch', 'UPDATE wallet_reservations SET amount_cents=401', () => []],
  ['reference mismatch', "UPDATE ledger_transactions SET reference_id=$1 WHERE type='AUCTION_SETTLEMENT'", () => [randomUUID()]],
  ['transaction type mismatch', "UPDATE ledger_transactions SET type='DEPOSIT' WHERE type='AUCTION_SETTLEMENT'", () => []],
  ['wrong paired amounts', "UPDATE ledger_entries SET amount_cents=amount_cents+1 WHERE transaction_id=(SELECT ledger_transaction_id FROM auction_settlements)", () => []],
  ['reversed balanced transfer', 'UPDATE ledger_entries SET amount_cents=-amount_cents WHERE transaction_id=(SELECT ledger_transaction_id FROM auction_settlements)', () => []],
  ['balanced transfer to another recipient', 'UPDATE ledger_entries SET account_id=(SELECT a.id FROM ledger_accounts a JOIN wallets w ON w.id=a.wallet_id WHERE w.user_id=$1) WHERE amount_cents>0 AND transaction_id=(SELECT ledger_transaction_id FROM auction_settlements)', () => [f.users.bidder2]],
  ['extra ledger entry', "INSERT INTO ledger_entries(id,transaction_id,account_id,amount_cents,created_at) SELECT $1,ledger_transaction_id,(SELECT id FROM ledger_accounts LIMIT 1),0,now() FROM auction_settlements", () => [randomUUID()]],
  ['bidder identity mismatch', 'UPDATE bids SET bidder_id=$1 WHERE id=$2', () => [f.users.bidder2, bidId]],
]) test(`receipt refuses ${name} with a sanitized conflict`, async () => {
  await f.pool.query(sql, params());
  const response = await request();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: { code: 'RECEIPT_INCONSISTENT', message: 'Receipt financial records are inconsistent' } });
});

test('receipt rejects a winning bid that belongs to another auction', async () => {
  const other = await f.createAuction();
  await f.pool.query('UPDATE bids SET auction_id=$1 WHERE id=$2', [other.id, bidId]);
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'RECEIPT_INCONSISTENT');
});
