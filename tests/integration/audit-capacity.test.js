import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { settlementFixture } from '../helpers/settlements.js';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';
import { hashEvent, GENESIS_HASH } from '../../src/modules/audit/domain/cryptography.ts';
import { AuditVerifier } from '../../src/modules/audit/services/audit-verifier.ts';
import { DrizzleReceiptRepository } from '../../src/modules/settlements/repositories/drizzle-receipt-repository.ts';
import { AuctionService } from '../../src/modules/auctions/services/auction-service.ts';
import { DrizzleAuctionRepository } from '../../src/modules/auctions/repositories/drizzle-auction-repository.ts';

let f, repository;
before(async () => { f = await settlementFixture(); repository = new DrizzleAuditRepository(f.db); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });

// Reuses the original REL-001 reproduction: reachable no-op edits are inserted in bulk.
// Version-2 binding belongs only to genesis; no witness signing or 10000 HTTP requests claimed.
async function fill(id, count) {
  const original = (await repository.snapshot(id)).events;
  const events = []; let previousHash = GENESIS_HASH;
  for (let i = 0; i < count; i++) {
    const isBid = original.length === 2 && i === count - 1;
    const source = { ...(isBid ? original[1] : original[0]) };
    delete source.eventHash;
    const payload = { ...source.payload };
    if (i > 0 && !isBid) delete payload.binding;
    const event = { ...source, payload, id: randomUUID(), sequence: BigInt(i + 1),
      eventType: i === 0 ? 'AUCTION_CREATED' : isBid ? 'BID_ACCEPTED' : 'AUCTION_UPDATED', previousHash };
    event.eventHash = hashEvent(event); previousHash = event.eventHash; events.push(event);
  }
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1', [id]);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1', [id]);
  await f.pool.query(`INSERT INTO audit_events(id,auction_id,sequence,event_type,payload,created_at,previous_hash,event_hash,hash_version)
    SELECT id::uuid,auction_id::uuid,sequence::bigint,event_type,payload,created_at::timestamp,previous_hash,event_hash,hash_version::int
    FROM jsonb_to_recordset($1::jsonb) AS x(id text,auction_id text,sequence text,event_type text,payload jsonb,created_at text,previous_hash text,event_hash text,hash_version int)`,
  [JSON.stringify(events.map(e => ({ id: e.id, auction_id: e.auctionId, sequence: String(e.sequence), event_type: e.eventType,
    payload: e.payload, created_at: e.createdAt, previous_hash: e.previousHash, event_hash: e.eventHash, hash_version: e.hashVersion })))]);
  await f.anchor(id);
  assert.equal((await f.gate.inspect(id)).status, 'VERIFIED');
  return events;
}

async function finances() {
  const tables = ['wallets', 'wallet_reservations', 'bids', 'bid_operations', 'ledger_transactions', 'ledger_entries'];
  return Promise.all(tables.map(async table => (await f.pool.query(`SELECT row_to_json(t) AS value FROM ${table} t ORDER BY id`)).rows));
}

async function assertSettled(a, before, size) {
  const results = await Promise.all(Array.from({ length: 4 }, () => f.settlementService.settle(a.id)));
  assert.ok(results.every(result => result.status === 'SETTLED' && result.settlementId === results[0].settlementId));
  const snapshot = await repository.snapshot(a.id);
  assert.equal(snapshot.events.length, size + 1);
  assert.deepEqual(snapshot.events.slice(0, size).map(e => e.eventHash), before.map(e => e.eventHash));
  assert.equal(snapshot.events.at(-1).eventType, 'AUCTION_SETTLED');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM auction_settlements')).rows[0].n, 1);
  const balances = (await f.pool.query('SELECT user_id,balance_cents::text,reserved_cents::text FROM wallets')).rows;
  assert.equal(balances.find(w => w.user_id === f.users.bidder1).balance_cents, '99900');
  assert.equal(balances.find(w => w.user_id === f.users.bidder1).reserved_cents, '0');
  assert.equal(balances.find(w => w.user_id === f.users.auctioneer).balance_cents, '100');
  assert.deepEqual((await f.pool.query('SELECT status FROM wallet_reservations')).rows, [{ status: 'CAPTURED' }]);
  assert.ok((await f.pool.query('SELECT sum(amount_cents)::text total FROM ledger_entries GROUP BY transaction_id')).rows.every(row => row.total === '0'));
  assert.equal((await new DrizzleReceiptRepository(f.db).find(a.id)).integrityConsistent, true);
  await f.anchor(a.id);
  assert.equal((await new AuditVerifier(repository, f.external).verify(a.id)).status, 'VERIFIED');
}

test('original REL-001: an existing valid 10000-event history settles once, preserves prefix and releases reservation by capture', async () => {
  const a = await f.expiredAuction(); const before = await fill(a.id, 10000);
  await assertSettled(a, before, 10000);
});

test('9999 nonterminal events reject new bids atomically and retain a reserved terminal slot', async () => {
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const a = await f.createAuction();
  await f.service.placeBid(f.users.bidder1, a.id, 100n, 'initial');
  const before = await fill(a.id, 9999); const initial = await finances();
  await assert.rejects(f.service.placeBid(f.users.bidder2, a.id, 110n, 'capacity'), e => e.status === 409 && e.code === 'AUDIT_CAPACITY_EXCEEDED');
  assert.deepEqual(await finances(), initial);
  assert.equal((await repository.snapshot(a.id)).events.length, 9999);
  // Use database time after the recorded deadline; no mutation of committed auction terms.
  const { SettlementService } = await import('../../src/modules/settlements/services/settlement-service.ts');
  const service = new SettlementService({ ...f.settlementRepository,
    terminal: id => f.settlementRepository.terminal(id),
    transaction: work => f.settlementRepository.transaction(tx => work({ ...tx, now: async () => new Date(Date.parse(a.endsAt) + 1) })),
  }, f.gate);
  const result = await service.settle(a.id);
  assert.equal(result.status, 'SETTLED');
  const snapshot = await repository.snapshot(a.id);
  assert.equal(snapshot.events.length, 10000);
  assert.deepEqual(snapshot.events.slice(0, 9999).map(e => e.eventHash), before.map(e => e.eventHash));
  assert.equal((await f.pool.query("SELECT reserved_cents::text FROM wallets WHERE user_id=$1", [f.users.bidder1])).rows[0].reserved_cents, '0');
});

test('existing 10000 events without bids close safely and cannot append after terminal', async () => {
  const a = await f.expiredAuction(false); await fill(a.id, 10000);
  assert.equal((await f.settlementService.settle(a.id)).status, 'CLOSED_NO_BIDS');
  assert.equal((await repository.snapshot(a.id)).events.length, 10001);
  assert.equal((await f.settlementService.settle(a.id)).status, 'CLOSED_NO_BIDS');
  const last = (await repository.snapshot(a.id)).events.at(-1);
  const { auctionId, eventType, payload, createdAt } = last;
  await assert.rejects(f.db.transaction(tx => new DrizzleAuditAppender(tx).append({ auctionId, eventType, payload, createdAt })), e => e.code === 'AUDIT_CAPACITY_EXCEEDED' || e.code === 'AUDIT_STATE_CONFLICT');
  assert.equal((await repository.snapshot(a.id)).events.length, 10001);
});

test('scheduled edits cannot consume the terminal slot; cancellation remains possible', async () => {
  const a = await f.createAuction({ startsAt: new Date(Date.now() + 3600000), endsAt: new Date(Date.now() + 7200000) });
  await fill(a.id, 9999);
  const service = new AuctionService(new DrizzleAuctionRepository(f.db, tx => new DrizzleAuditAppender(tx)));
  await assert.rejects(service.edit(a.id, f.users.auctioneer, {}), e => e.code === 'AUDIT_CAPACITY_EXCEEDED');
  assert.equal((await service.cancel(a.id, f.users.auctioneer)).status, 'CANCELLED');
  assert.equal((await repository.snapshot(a.id)).events.length, 10000);
});
