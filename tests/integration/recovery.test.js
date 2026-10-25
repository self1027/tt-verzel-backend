import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { settlementFixture } from '../helpers/settlements.js';
import { RecoveryService } from '../../src/modules/auctions/services/recovery-service.ts';
import { AuditVerifier } from '../../src/modules/audit/services/audit-verifier.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { holdRow, waitBlocked } from '../helpers/bid-locks.js';
import { SettlementService } from '../../src/modules/settlements/services/settlement-service.ts';
import { DrizzleReservationOperations } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';
import { AnchorWorker } from '../../src/modules/audit/services/anchor-worker.ts';

let f;
before(async () => { f = await settlementFixture(); });
beforeEach(async () => { await f.pool.query('DELETE FROM auction_recoveries'); await f.reset(); });
after(async () => { await f?.close(); });
const recovery = () => new RecoveryService(f.db);
const row = async id => (await f.pool.query('SELECT * FROM auction_recoveries WHERE auction_id=$1', [id])).rows[0];
async function tamper(id) { await f.pool.query("UPDATE audit_events SET event_hash=repeat('f',64) WHERE auction_id=$1 AND sequence=1", [id]); }
async function verify(id) {
  return new AuditVerifier(new DrizzleAuditRepository(f.db), f.external,
    (result, verificationEvidence) => recovery().detect(result.auctionId, { ...result, verificationEvidence })).verify(id);
}

test('confirmed tampering releases once, cancels and preserves original evidence under concurrent detection', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1');
  await f.service.placeBid(f.users.bidder1, a.id, 100n, 'first'); await tamper(a.id);
  const original = (await f.pool.query('SELECT * FROM audit_events ORDER BY sequence')).rows;
  await Promise.all([verify(a.id), verify(a.id), verify(a.id)]);
  const incident = await row(a.id);
  assert.equal(incident.state, 'RELEASED'); assert.equal(incident.released_cents, '100');
  assert.equal(+incident.target_at - +incident.detected_at, 180000);
  assert.equal((await f.pool.query('SELECT status FROM auctions WHERE id=$1', [a.id])).rows[0].status, 'CANCELLED');
  assert.deepEqual((await f.pool.query('SELECT * FROM audit_events ORDER BY sequence')).rows, original);
  assert.equal((await f.pool.query('SELECT reserved_cents FROM wallets WHERE user_id=$1', [f.users.bidder1])).rows[0].reserved_cents, '0');
  assert.equal((await f.pool.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [f.users.bidder1])).rows[0].balance_cents, '100000');
  assert.equal((await f.pool.query('SELECT count(*) FROM auction_recoveries')).rows[0].count, '1');
  assert.equal((await verify(a.id)).status, 'TAMPERED');
  assert.equal((await row(a.id)).released_cents, '100');
  assert.ok(JSON.parse(incident.evidence).detection.verificationEvidence.includes('ffffffff'));
  await assert.rejects(f.pool.query("UPDATE auction_recoveries SET evidence='rewritten' WHERE auction_id=$1", [a.id]));
});

test('pending anchor and unavailable witness never start recovery', async () => {
  const a = await f.createAuction();
  assert.equal((await verify(a.id)).status, 'PENDING_ANCHOR');
  const unavailable = new AuditVerifier(new DrizzleAuditRepository(f.db), { latest: async () => { throw Error('offline'); } },
    result => recovery().detect(result.auctionId, result));
  assert.equal((await unavailable.verify(a.id)).status, 'VERIFICATION_UNAVAILABLE');
  assert.equal(await row(a.id), undefined);
  await tamper(a.id);
  assert.equal((await unavailable.verify(a.id)).status, 'TAMPERED');
  assert.equal((await row(a.id)).state, 'RELEASED');
});

test('partial failure rolls back release; persisted retry survives reconstruction and blocks bids and settlement', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1'); await f.deposit('bidder2');
  await f.service.placeBid(f.users.bidder1, a.id, 100n, 'first'); await tamper(a.id);
  await f.pool.query(`CREATE FUNCTION reject_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='CANCELLED' THEN RAISE EXCEPTION 'simulated outage'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_cancel BEFORE UPDATE ON auctions FOR EACH ROW EXECUTE FUNCTION reject_cancel()`);
  await verify(a.id);
  assert.equal((await row(a.id)).state, 'PENDING');
  assert.equal((await row(a.id)).released_cents, '0');
  assert.equal((await f.pool.query('SELECT reserved_cents FROM wallets WHERE user_id=$1', [f.users.bidder1])).rows[0].reserved_cents, '100');
  await assert.rejects(f.service.placeBid(f.users.bidder2, a.id, 110n, 'second'), { code: 'AUDIT_TAMPERED' });
  assert.equal((await f.settlementService.settle(a.id)).status, 'TAMPERED');
  await f.pool.query('DROP TRIGGER reject_cancel ON auctions; DROP FUNCTION reject_cancel()');
  await f.pool.query("UPDATE auction_recoveries SET next_attempt_at=clock_timestamp() AT TIME ZONE 'UTC'");
  await recovery().runOnce();
  assert.equal((await row(a.id)).state, 'RELEASED');
  assert.equal((await row(a.id)).attempts, 2);
});

test('captured settlement is preserved and marked for specific compensation', async () => {
  const a = await f.expiredAuction(); await f.settlementService.settle(a.id);
  const ledger = (await f.pool.query('SELECT * FROM ledger_transactions ORDER BY id')).rows;
  await tamper(a.id); await verify(a.id);
  assert.equal((await row(a.id)).state, 'COMPENSATION_REQUIRED');
  assert.equal((await row(a.id)).captured_cents, '100');
  assert.equal((await row(a.id)).released_cents, '0');
  assert.equal((await f.pool.query('SELECT status FROM auctions WHERE id=$1', [a.id])).rows[0].status, 'SETTLED');
  assert.deepEqual((await f.pool.query('SELECT * FROM ledger_transactions ORDER BY id')).rows, ledger);
});

test('auction lock serializes recovery against bid and settlement; later operations see durable block', async () => {
  const a = await f.expiredAuction();
  const holder = await holdRow(f.pool, 'SELECT id FROM auctions WHERE id=$1 FOR UPDATE', [a.id]);
  const detecting = recovery().detect(a.id, { status: 'TAMPERED', reason: 'EXTERNAL_ANCHOR_MISMATCH' });
  await waitBlocked(f.pool, holder.pid); await holder.release(); await detecting;
  assert.equal((await f.settlementService.settle(a.id)).status, 'TAMPERED');
  await assert.rejects(f.service.placeBid(f.users.bidder2, a.id, 110n, 'blocked'), { code: 'AUDIT_TAMPERED' });
});

test('verified proof obtained before quarantine cannot capture after quarantine commits', async () => {
  const a = await f.expiredAuction();
  let proofRead, continueSettlement;
  const entered = new Promise(resolve => { proofRead = resolve; });
  const proceed = new Promise(resolve => { continueSettlement = resolve; });
  const staleGate = { async inspect(id) { const decision = await f.gate.inspect(id); proofRead(); await proceed; return decision; } };
  const attempt = new SettlementService(f.settlementRepository, staleGate).settle(a.id);
  // Attach a rejection handler before releasing the proof to avoid unhandled rejections.
  const rejected = assert.rejects(attempt, { code: 'AUDIT_TAMPERED' });
  await entered;
  await recovery().detect(a.id, { status: 'TAMPERED', reason: 'EXTERNAL_ANCHOR_MISMATCH' });
  continueSettlement(); await rejected;
  assert.equal((await f.pool.query("SELECT count(*) FROM ledger_transactions WHERE type='AUCTION_SETTLEMENT'")).rows[0].count, '0');
});

test('inconsistent wallet remains committed until retry can reconcile; direct capture is also blocked', async () => {
  const a = await f.expiredAuction();
  const reservation = (await f.pool.query('SELECT * FROM wallet_reservations WHERE auction_id=$1', [a.id])).rows[0];
  const sellerWallet = (await f.pool.query('SELECT id FROM wallets WHERE user_id=$1', [f.users.auctioneer])).rows[0].id;
  await f.pool.query('UPDATE wallets SET reserved_cents=99 WHERE user_id=$1', [f.users.bidder1]);
  await tamper(a.id); await verify(a.id);
  const pending = await row(a.id);
  assert.equal(pending.state, 'PENDING'); assert.equal(pending.last_error, 'INVALID_WALLET_STATE');
  const response = await (await f.request(`/${a.id}`, { token: null })).json();
  assert.equal(response.auction.recovery.remainingReservedCents, '100');
  assert.equal(response.auction.recovery.releasedCents, '0');
  assert.equal(response.auction.recovery.state, 'PENDING');
  await assert.rejects(f.db.transaction(tx => new DrizzleReservationOperations().captureReservation(tx,
    { reservationId: reservation.id, recipientWalletId: sellerWallet, idempotencyKey: 'forbidden-capture' })), { code: 'AUDIT_TAMPERED' });
  await f.pool.query('UPDATE wallets SET reserved_cents=100 WHERE user_id=$1', [f.users.bidder1]);
  await recovery().process(a.id);
  assert.equal((await row(a.id)).state, 'RELEASED');
});

test('voluntary cancellation keeps ownership and no-bid rules; repeats cannot double release or append', async () => {
  const a = await f.createAuction();
  assert.equal((await f.request(`/${a.id}/cancel`, { method: 'POST', token: f.tokens.bidder1 })).status, 403);
  const result = await f.request(`/${a.id}/cancel`, { method: 'POST', token: f.tokens.auctioneer });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).auction.cancellationReason, 'SELLER_REQUEST');
  assert.equal((await f.request(`/${a.id}/cancel`, { method: 'POST', token: f.tokens.auctioneer })).status, 409);
  assert.equal((await f.pool.query("SELECT count(*) FROM audit_events WHERE event_type='AUCTION_CANCELLED'")).rows[0].count, '1');
  assert.equal((await (await f.request('', { token: null })).json()).total, 0);
  assert.equal((await f.request(`/${a.id}`, { token: null })).status, 200);
  assert.equal((await (await f.request('/mine', { token: f.tokens.auctioneer })).json()).total, 1);
});

test('anchor worker starts recovery for a cryptographically noncanonical stored timestamp', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1');
  await f.service.placeBid(f.users.bidder1, a.id, 100n, 'first');
  await f.pool.query("UPDATE audit_events SET created_at=created_at+interval '1 microsecond' WHERE auction_id=$1 AND sequence=1", [a.id]);
  const worker = new AnchorWorker(new DrizzleAuditRepository(f.db), { ...f.external, publish: async () => { assert.fail('Corrupt history must never be published'); } },
    (result, verificationEvidence) => recovery().detect(result.auctionId, { ...result, verificationEvidence }));
  assert.ok((await worker.runOnce()).blocked > 0);
  assert.equal((await row(a.id)).state, 'RELEASED');
  assert.equal((await row(a.id)).released_cents, '100');
});

test('receipt verification records required compensation for confirmed tampering without any refund', async () => {
  const a = await f.expiredAuction(); await f.settlementService.settle(a.id);
  const ledger = (await f.pool.query('SELECT * FROM ledger_transactions ORDER BY id')).rows;
  await tamper(a.id);
  assert.equal((await f.request(`/${a.id}/receipt`, { token: null })).status, 409);
  assert.equal((await row(a.id)).state, 'COMPENSATION_REQUIRED');
  assert.equal((await row(a.id)).captured_cents, '100');
  assert.deepEqual((await f.pool.query('SELECT * FROM ledger_transactions ORDER BY id')).rows, ledger);
  assert.ok(JSON.parse((await row(a.id)).evidence).detection.verificationEvidence.includes('ffffffff'));
});

test('a receipt financial inconsistency alone does not invent cryptographically confirmed tampering', async () => {
  const a = await f.expiredAuction(); await f.settlementService.settle(a.id);
  await f.pool.query("UPDATE ledger_entries SET amount_cents=amount_cents+1 WHERE transaction_id IN (SELECT id FROM ledger_transactions WHERE type='AUCTION_SETTLEMENT')");
  assert.equal((await f.request(`/${a.id}/receipt`, { token: null })).status, 409);
  assert.equal(await row(a.id), undefined);
});
