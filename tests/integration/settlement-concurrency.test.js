import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { settlementFixture } from '../helpers/settlements.js';
import { SettlementService } from '../../src/modules/settlements/services/settlement-service.ts';
import { DrizzleSettlementAuditGate } from '../../src/modules/settlements/infrastructure/settlement-proof.ts';
import { holdRow, waitBlocked } from '../helpers/bid-locks.js';
import { BidService } from '../../src/modules/bids/services/bid-service.ts';

let f;
before(async () => { f = await settlementFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });

async function financialState(id) {
  return {
    wallets: (await f.pool.query('SELECT id,balance_cents,reserved_cents FROM wallets ORDER BY id')).rows,
    reservations: (await f.pool.query('SELECT id,status FROM wallet_reservations ORDER BY id')).rows,
    settlements: (await f.pool.query('SELECT id FROM auction_settlements WHERE auction_id=$1', [id])).rows,
    ledger: (await f.pool.query("SELECT id FROM ledger_transactions WHERE type='AUCTION_SETTLEMENT' ORDER BY id")).rows,
    auction: (await f.pool.query('SELECT status FROM auctions WHERE id=$1', [id])).rows,
  };
}

test('settlement rechecks intermediate chain integrity after external verification', async () => {
  const auction = await f.expiredAuction();
  const before = await financialState(auction.id);
  const gate = { async inspect(id) {
    const result = await f.gate.inspect(id);
    assert.equal(result.status, 'VERIFIED');
    await f.pool.query("UPDATE audit_events SET previous_hash=$1 WHERE auction_id=$2 AND sequence=1", ['f'.repeat(64), id]);
    return result;
  } };
  const result = await new SettlementService(f.settlementRepository, gate).settle(auction.id);
  assert.equal(result.status, 'DEFERRED');
  assert.deepEqual(await financialState(auction.id), before);
});

test('two settlement callers capture and credit once and replay the same settlement', async () => {
  const auction = await f.expiredAuction();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => f.settlementService.settle(auction.id)));
  outcomes.forEach(row => {
    assert.equal(row.status, 'SETTLED');
    assert.equal(row.settlementId, outcomes[0].settlementId);
  });
  const state = await financialState(auction.id);
  assert.equal(state.settlements.length, 1);
  assert.equal(state.ledger.length, 1);
  assert.deepEqual(state.reservations.map(row => row.status), ['CAPTURED']);
  assert.equal(state.wallets.reduce((total, row) => total + BigInt(row.balance_cents), 0n), 100000n);
  const seller = (await f.pool.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [f.users.auctioneer])).rows[0];
  assert.equal(seller.balance_cents, '100');
});

for (const step of ['capture', 'insert', 'finish', 'auditSettlement']) {
  test(`a fault after ${step} rolls back all financial writes and permits retry`, async () => {
    const auction = await f.expiredAuction();
    const before = await financialState(auction.id);
    const repository = {
      terminal: id => f.settlementRepository.terminal(id),
      transaction: work => f.settlementRepository.transaction(tx => work({ ...tx, [step]: async (...args) => {
        await tx[step](...args);
        throw new Error(`fault after ${step}`);
      } })),
    };
    await assert.rejects(new SettlementService(repository, f.gate).settle(auction.id), new RegExp(`fault after ${step}`));
    assert.deepEqual(await financialState(auction.id), before);
    assert.equal((await f.settlementService.settle(auction.id)).status, 'SETTLED');
  });
}

test('unavailable witness, pending anchor and tampered audit leave financial state unchanged', async () => {
  const auction = await f.expiredAuction();
  const before = await financialState(auction.id);
  const unavailable = new DrizzleSettlementAuditGate(f.db, { async latest() { throw new Error('witness offline'); } });
  const deferred = await new SettlementService(f.settlementRepository, unavailable).settle(auction.id);
  assert.equal(deferred.status, 'DEFERRED');
  assert.equal(deferred.reason, 'VERIFICATION_UNAVAILABLE');
  f.heads.clear();
  assert.equal((await f.settlementService.settle(auction.id)).status, 'DEFERRED');
  await f.anchor(auction.id);
  await f.pool.query("UPDATE audit_events SET previous_hash=$1 WHERE auction_id=$2 AND sequence=1", ['f'.repeat(64), auction.id]);
  assert.equal((await f.settlementService.settle(auction.id)).status, 'TAMPERED');
  assert.deepEqual(await financialState(auction.id), before);
});

test('operational proof changes between verification and auction lock defer capture', async () => {
  const auction = await f.expiredAuction();
  const before = await financialState(auction.id);
  const gate = { async inspect(id) {
    const result = await f.gate.inspect(id);
    await f.pool.query("UPDATE auctions SET ends_at=ends_at-interval '1 second' WHERE id=$1", [id]);
    return result;
  } };
  const outcome = await new SettlementService(f.settlementRepository, gate).settle(auction.id);
  assert.equal(outcome.status, 'DEFERRED');
  assert.equal(outcome.reason, 'AUDIT_VERSION_CHANGED');
  assert.deepEqual(await financialState(auction.id), before);
});

test('auction lock wait observes a newly extended deadline before settlement', async () => {
  const auction = await f.expiredAuction();
  const before = await financialState(auction.id);
  const client = await f.pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await client.query('SELECT id FROM auctions WHERE id=$1 FOR UPDATE', [auction.id]);
    pending = f.settlementService.settle(auction.id);
    await waitBlocked(f.pool, pid);
    await client.query("UPDATE auctions SET ends_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [auction.id]);
    await client.query('COMMIT');
    assert.equal((await pending).status, 'NOT_DUE');
    assert.deepEqual(await financialState(auction.id), before);
  } finally { await client.query('ROLLBACK'); client.release(); await pending?.catch(() => {}); }
});

test('wallet lock wait revalidates the audit proof before capture', async () => {
  const auction = await f.expiredAuction();
  const before = await financialState(auction.id);
  const holder = await holdRow(f.pool, 'SELECT id FROM wallets WHERE user_id=$1 FOR UPDATE', [f.users.bidder1]);
  let pending;
  try {
    pending = f.settlementService.settle(auction.id);
    await waitBlocked(f.pool, holder.pid);
    await f.pool.query("UPDATE audit_events SET previous_hash=$1 WHERE auction_id=$2 AND sequence=1", ['f'.repeat(64), auction.id]);
    await holder.release();
    assert.equal((await pending).status, 'DEFERRED');
    assert.deepEqual(await financialState(auction.id), before);
  } finally { await holder.release(); await pending?.catch(() => {}); }
});

test('a competing valid bid extends the auction after verification and prevents capture', async () => {
  const auction = await f.expiredAuction();
  await f.deposit('bidder2');
  const bidTime = new Date(Date.parse(auction.endsAt) - 1000);
  const bidder = new BidService({ transaction: work => f.repository.transaction(tx => work({ ...tx, databaseNow: async () => bidTime })) }, f.service);
  const gate = { async inspect(id) {
    const proof = await f.gate.inspect(id);
    await bidder.placeBid(f.users.bidder2, id, 110n, 'competing-extension');
    return proof;
  } };
  const result = await new SettlementService(f.settlementRepository, gate).settle(auction.id);
  assert.equal(result.status, 'NOT_DUE');
  const state = await financialState(auction.id);
  assert.equal(state.settlements.length, 0);
  assert.equal(state.ledger.length, 0);
  assert.deepEqual(state.reservations.map(row => row.status).sort(), ['ACTIVE', 'RELEASED']);
  const stored = (await f.pool.query('SELECT ends_at FROM auctions WHERE id=$1', [auction.id])).rows[0];
  assert.ok(+stored.ends_at > Date.parse(auction.endsAt));
});

test('ledger insertion failure rolls back the auction, reservation and account balances', async () => {
  const auction = await f.expiredAuction();
  const before = await financialState(auction.id);
  await f.pool.query("CREATE FUNCTION reject_settlement_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM ledger_transactions WHERE id=NEW.transaction_id AND type='AUCTION_SETTLEMENT') THEN RAISE EXCEPTION 'injected ledger failure'; END IF; RETURN NEW; END $$");
  await f.pool.query('CREATE TRIGGER reject_settlement_entry BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_settlement_entry()');
  try {
    await assert.rejects(f.settlementService.settle(auction.id), error => error.cause?.message === 'injected ledger failure');
    assert.deepEqual(await financialState(auction.id), before);
  } finally {
    await f.pool.query('DROP TRIGGER reject_settlement_entry ON ledger_entries');
    await f.pool.query('DROP FUNCTION reject_settlement_entry()');
  }
  assert.equal((await f.settlementService.settle(auction.id)).status, 'SETTLED');
});
