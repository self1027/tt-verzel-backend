import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';
import { BidService } from '../../src/modules/bids/services/bid-service.ts';

let f;
before(async () => { f = await bidFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });
function place(auction, amount = '100', name = 'bidder1', key = randomUUID()) {
  return f.request(`/${auction.id}/bids`, { method: 'POST', token: f.tokens[name], key, body: { amountCents: amount } });
}
async function reject(response, code) {
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, code);
}
async function stored(auction) {
  return (await f.pool.query(`SELECT current_bid_id,to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends_at FROM auctions WHERE id=$1`, [auction.id])).rows[0];
}
async function assertEmpty(auction) {
  assert.equal((await stored(auction)).current_bid_id, null);
  assert.equal((await f.pool.query('SELECT count(*) FROM bids')).rows[0].count, '0');
  assert.equal((await f.pool.query('SELECT count(*) FROM wallet_reservations')).rows[0].count, '0');
  assert.equal((await f.pool.query('SELECT count(*) FROM bid_operations')).rows[0].count, '0');
}
async function invariants(auction, count, expectedReserved) {
  const rows = (await f.pool.query('SELECT sequence::text FROM bids WHERE auction_id=$1 ORDER BY sequence', [auction.id])).rows;
  assert.deepEqual(rows.map((row) => row.sequence), Array.from({ length: count }, (_, i) => String(i + 1)));
  const active = (await f.pool.query("SELECT r.bid_id,r.amount_cents::text FROM wallet_reservations r WHERE auction_id=$1 AND status='ACTIVE'", [auction.id])).rows;
  assert.equal(active.length, 1);
  assert.equal(active[0].bid_id, (await stored(auction)).current_bid_id);
  const balances = (await f.pool.query('SELECT u.email,w.balance_cents::text,w.reserved_cents::text,coalesce(sum(r.amount_cents) FILTER (WHERE r.status=\'ACTIVE\'),0)::text AS active_sum FROM wallets w JOIN users u ON u.id=w.user_id LEFT JOIN wallet_reservations r ON r.wallet_id=w.id GROUP BY w.id,u.email')).rows;
  for (const [name, reserved] of Object.entries(expectedReserved)) {
    const row = balances.find((row) => row.email === `${name}@verzel.local`);
    assert.equal(row.reserved_cents, reserved);
    assert.equal(row.active_sum, reserved);
    assert.equal(row.balance_cents, '100000');
  }
}

test('first bid accepts the initial minimum and preserves ledger and total balances', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1');
  const ledger = (await f.pool.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
  const response = await place(a);
  assert.equal(response.status, 201);
  const { bid } = await response.json();
  assert.equal(bid.amountCents, '100'); assert.equal(bid.sequence, '1');
  assert.equal(bid.endsAt, a.endsAt);
  await invariants(a, 1, { bidder1: '100' });
  assert.deepEqual((await f.pool.query('SELECT * FROM ledger_entries ORDER BY id')).rows, ledger);
});

test('BIGINT maximum stays exact end to end and an overflowing next minimum cannot mutate balances', async () => {
  const maximum = '9223372036854775807';
  const a = await f.createAuction();
  await f.deposit('bidder1', maximum); await f.deposit('bidder2', maximum);
  const response = await place(a, maximum);
  assert.equal(response.status, 201);
  const original = await response.json();
  assert.equal(original.bid.amountCents, maximum);
  await reject(await place(a, maximum, 'bidder2'), 'BID_LIMIT');
  const balance = (await f.pool.query('SELECT balance_cents::text,reserved_cents::text FROM wallets WHERE user_id=$1', [f.users.bidder1])).rows[0];
  assert.deepEqual(balance, { balance_cents: maximum, reserved_cents: maximum });
  assert.equal((await f.pool.query('SELECT count(*) FROM bids')).rows[0].count, '1');
  assert.equal((await f.pool.query('SELECT count(*) FROM bid_operations')).rows[0].count, '1');
});

test('bids below initial price, increment and own leadership reject without changing leader or deadline', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  await reject(await place(a, '99'), 'BID_TOO_LOW');
  await assertEmpty(a);
  assert.equal((await place(a)).status, 201);
  const before = await stored(a);
  await reject(await place(a, '109', 'bidder2'), 'BID_TOO_LOW');
  await reject(await place(a, '110'), 'ALREADY_LEADING');
  assert.deepEqual(await stored(a), before);
  await invariants(a, 1, { bidder1: '100', bidder2: '0' });
});

test('outbid releases the previous leader and reserves the exact new amount without ledger movement', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  assert.equal((await place(a)).status, 201);
  const ledger = (await f.pool.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
  assert.equal((await place(a, '110', 'bidder2')).status, 201);
  await invariants(a, 2, { bidder1: '0', bidder2: '110' });
  const released = (await f.pool.query("SELECT amount_cents::text,released_at FROM wallet_reservations WHERE status='RELEASED'")).rows;
  assert.equal(released.length, 1); assert.equal(released[0].amount_cents, '100'); assert.ok(released[0].released_at);
  assert.deepEqual((await f.pool.query('SELECT * FROM ledger_entries ORDER BY id')).rows, ledger);
});

test('failure immediately after old reservation release rolls the whole outbid back', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  assert.equal((await place(a)).status, 201);
  const before = await stored(a);
  const reservations = (await f.pool.query('SELECT * FROM wallet_reservations ORDER BY id')).rows;
  const service = new BidService({ transaction: (work) => f.repository.transaction((tx) => work({
    ...tx, async releaseReservation(id) {
      await tx.releaseReservation(id);
      throw new Error('failure after old release');
    },
  })) }, {});
  await assert.rejects(service.placeBid(f.users.bidder2, a.id, 110n, 'rollback'), /failure after old release/);
  assert.deepEqual(await stored(a), before);
  assert.deepEqual((await f.pool.query('SELECT * FROM wallet_reservations ORDER BY id')).rows, reservations);
  await invariants(a, 1, { bidder1: '100', bidder2: '0' });
  assert.equal((await f.pool.query('SELECT count(*) FROM bid_operations')).rows[0].count, '1');
  assert.equal((await f.pool.query("SELECT count(*) FROM audit_events WHERE event_type='BID_ACCEPTED'")).rows[0].count, '1');
});

for (const mode of ['scheduled', 'expired', 'cancelled']) {
  test(`${mode} auctions reject bids without a financial effect`, async () => {
    const now = await f.clock();
    const overrides = mode === 'scheduled' ? { startsAt: new Date(+now + 3600000), endsAt: new Date(+now + 7200000) }
      : mode === 'expired' ? { endsAt: new Date(+now - 1) } : { status: 'CANCELLED' };
    const a = await f.createAuction(overrides);
    await f.deposit('bidder1');
    await reject(await place(a), 'AUCTION_NOT_LIVE');
    await assertEmpty(a);
    assert.equal((await stored(a)).ends_at, a.endsAt);
  });
}

test('insufficient available funds leave no bid, reservation, operation or extension', async () => {
  const a = await f.createAuction({ endsAt: new Date(+(await f.clock()) + 60000) });
  await f.deposit('bidder1', '99');
  await reject(await place(a), 'INSUFFICIENT_FUNDS');
  await assertEmpty(a);
  assert.equal((await stored(a)).ends_at, a.endsAt);
});

test('persistent key replays the original receipt after outbid, expired deadline and settlement', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const first = await (await place(a, '100', 'bidder1', 'original')).json();
  assert.equal((await place(a, '110', 'bidder2')).status, 201);
  await f.pool.query("UPDATE auctions SET status='SETTLED',ends_at=clock_timestamp()-interval '1 second' WHERE id=$1", [a.id]);
  const retry = await place(a, '100', 'bidder1', 'original');
  assert.equal(retry.status, 201); assert.deepEqual(await retry.json(), first);
  await reject(await place(a, '101', 'bidder1', 'original'), 'IDEMPOTENCY_CONFLICT');
  await invariants(a, 2, { bidder1: '0', bidder2: '110' });
});

function serviceAt(now) {
  return new BidService({ transaction: (work) => f.repository.transaction((tx) => work({ ...tx, databaseNow: async () => now })) }, {});
}

test('exact DB-derived 120000ms boundary extends the stored old deadline by 120000ms', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1');
  const at = new Date(+new Date((await stored(a)).ends_at) - 120000);
  const bid = await serviceAt(at).placeBid(f.users.bidder1, a.id, 100n, 'boundary');
  assert.equal(bid.createdAt, at.toISOString());
  assert.equal(bid.endsAt, new Date(+new Date(a.endsAt) + 120000).toISOString());
  assert.equal((await stored(a)).ends_at, bid.endsAt);
  await invariants(a, 1, { bidder1: '100' });
});

test('120001ms does not extend, successive accepted bids extend from each old deadline and rejected bids do not', async () => {
  const a = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const originalEnd = +new Date(a.endsAt);
  const first = await serviceAt(new Date(originalEnd - 120001)).placeBid(f.users.bidder1, a.id, 100n, 'outside');
  assert.equal(first.endsAt, a.endsAt);
  const second = await serviceAt(new Date(originalEnd - 1)).placeBid(f.users.bidder2, a.id, 110n, 'extend-1');
  assert.equal(second.endsAt, new Date(originalEnd + 120000).toISOString());
  const third = await serviceAt(new Date(originalEnd + 119999)).placeBid(f.users.bidder1, a.id, 120n, 'extend-2');
  assert.equal(third.endsAt, new Date(originalEnd + 240000).toISOString());
  await assert.rejects(serviceAt(new Date(originalEnd + 239999)).placeBid(f.users.bidder2, a.id, 129n, 'rejected'), { code: 'BID_TOO_LOW' });
  assert.equal((await stored(a)).ends_at, third.endsAt);
  await invariants(a, 3, { bidder1: '120', bidder2: '0' });
});
