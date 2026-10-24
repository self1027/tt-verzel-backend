import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';
import { BidService } from '../../src/modules/bids/services/bid-service.ts';
import { DrizzleBidRepository } from '../../src/modules/bids/repositories/drizzle-bid-repository.ts';
import { DrizzleReservationOperations } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { AuditVerifier } from '../../src/modules/audit/services/audit-verifier.ts';
import { bidderReference } from '../../src/modules/audit/domain/cryptography.ts';

let f;
before(async () => { f = await bidFixture(); });
beforeEach(async () => { await f.reset(); await f.deposit('bidder1'); await f.deposit('bidder2'); });
after(async () => { await f?.close(); });
const place = (auctionId, name = 'bidder1', amount = 100n, key = 'bid-1') => f.service.placeBid(f.users[name], auctionId, amount, key);
async function state() {
  const tables = ['wallets', 'wallet_reservations', 'bids', 'auctions', 'audit_events', 'audit_anchors', 'bid_operations'];
  return Promise.all(tables.map(async table => (await f.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
}
test('accepted bid commits pseudonymous audit, exact extended deadline and pending consistent verification', async () => {
  const auction = await f.createAuction({ endsAt: new Date(+(await f.clock()) + 90000) });
  const receipt = await place(auction.id);
  assert.equal(receipt.endsAt, new Date(Date.parse(auction.endsAt) + 120000).toISOString());
  const repository = new DrizzleAuditRepository(f.db);
  const snapshot = await repository.snapshot(auction.id);
  const event = snapshot.events[1];
  assert.equal(event.eventType, 'BID_ACCEPTED');
  assert.deepEqual(event.payload, { bidId: receipt.id, bidderRef: bidderReference(auction.id, f.users.bidder1), amountCents: '100', bidSequence: '1', createdAt: receipt.createdAt, endsAt: receipt.endsAt });
  const serialized = JSON.stringify(event.payload);
  for (const secret of [f.users.bidder1, 'bidder1@verzel.local', 'password', 'walletId']) assert.ok(!serialized.includes(secret));
  const verification = await new AuditVerifier(repository, { latest: async () => null }).verify(auction.id);
  assert.equal(verification.status, 'PENDING_ANCHOR');
  assert.equal(verification.operationalCoverage, 'CONSISTENT');
  assert.equal(verification.localSequence, '2');
  assert.equal((await repository.pending(10)).length, 2);
});
test('audit insertion failure after old reservation release rolls back all business and audit writes', async () => {
  const auction = await f.createAuction();
  await place(auction.id);
  const before = await state();
  const repository = new DrizzleBidRepository(f.db, new DrizzleReservationOperations(), tx => ({
    async append(input) { await new DrizzleAuditAppender(tx).append(input); throw new Error('injected audit failure'); },
  }));
  const service = new BidService(repository, f.service);
  await assert.rejects(service.placeBid(f.users.bidder2, auction.id, 110n, 'second'), /injected audit failure/);
  assert.deepEqual(await state(), before);
  assert.equal((await place(auction.id, 'bidder2', 110n, 'second')).sequence, '2');
});
test('operation insertion failure rolls back released reservation and appended event/outbox', async () => {
  const auction = await f.createAuction();
  await place(auction.id);
  const before = await state();
  await f.pool.query("CREATE FUNCTION reject_bid_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected operation failure'; END $$; CREATE TRIGGER reject_bid_operation BEFORE INSERT ON bid_operations FOR EACH ROW EXECUTE FUNCTION reject_bid_operation()");
  try {
    await assert.rejects(place(auction.id, 'bidder2', 110n, 'second'));
    assert.deepEqual(await state(), before);
  } finally { await f.pool.query('DROP TRIGGER reject_bid_operation ON bid_operations; DROP FUNCTION reject_bid_operation()'); }
  assert.equal((await place(auction.id, 'bidder2', 110n, 'second')).sequence, '2');
});
test('missing auction genesis rejects the bid and rolls back new reservation, event and receipt', async () => {
  const auction = await f.createAuction();
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1', [auction.id]);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1', [auction.id]);
  const before = await state();
  await assert.rejects(place(auction.id), { status: 409, code: 'AUDIT_STATE_CONFLICT' });
  assert.deepEqual(await state(), before);
});
test('an unrecorded earlier bid prevents silently creating an incomplete audit history', async () => {
  const auction = await f.createAuction();
  await place(auction.id);
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1 AND last_sequence=2', [auction.id]);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1 AND sequence=2', [auction.id]);
  const before = await state();
  await assert.rejects(place(auction.id, 'bidder2', 110n, 'second'), { status: 409, code: 'AUDIT_STATE_CONFLICT' });
  assert.deepEqual(await state(), before);
});
