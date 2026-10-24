import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, beforeEach, after, test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';
import { holdRow, waitBlocked, waitDatabaseDeadline } from '../helpers/bid-locks.js';

let f;
before(async () => { f = await bidFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });
function place(a, amount = '100', name = 'bidder1', key = randomUUID()) {
  return f.request(`/${a.id}/bids`, { method: 'POST', token: f.tokens[name], key, body: { amountCents: amount } });
}
async function walletId(name) { return (await f.pool.query('SELECT id FROM wallets WHERE user_id=$1', [f.users[name]])).rows[0].id; }
function holdAuction(a) { return holdRow(f.pool, 'SELECT id FROM auctions WHERE id=$1 FOR UPDATE', [a.id]); }
async function holdWallet(name) { return holdRow(f.pool, 'SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [await walletId(name)]); }
async function invariants(a, count) {
  const bids = (await f.pool.query('SELECT id,sequence::text,amount_cents::text FROM bids WHERE auction_id=$1 ORDER BY sequence', [a.id])).rows;
  assert.deepEqual(bids.map((b) => b.sequence), Array.from({ length: count }, (_, i) => String(i + 1)));
  const active = (await f.pool.query("SELECT bid_id,amount_cents::text FROM wallet_reservations WHERE auction_id=$1 AND status='ACTIVE'", [a.id])).rows;
  assert.equal(active.length, count ? 1 : 0);
  const leader = (await f.pool.query('SELECT current_bid_id FROM auctions WHERE id=$1', [a.id])).rows[0].current_bid_id;
  assert.equal(leader, bids.at(-1)?.id ?? null);
  if (count) assert.deepEqual(active[0], { bid_id: leader, amount_cents: bids.at(-1).amount_cents });
  const wallets = (await f.pool.query("SELECT w.balance_cents::text,w.reserved_cents::text,coalesce(sum(r.amount_cents) FILTER (WHERE r.status='ACTIVE'),0)::text AS active FROM wallets w LEFT JOIN wallet_reservations r ON r.wallet_id=w.id GROUP BY w.id")).rows;
  for (const w of wallets) {
    assert.equal(w.reserved_cents, w.active);
    assert.ok(BigInt(w.balance_cents) >= BigInt(w.reserved_cents));
    assert.ok(BigInt(w.reserved_cents) >= 0n);
  }
  assert.equal((await f.pool.query('SELECT count(*) FROM bid_operations WHERE auction_id=$1', [a.id])).rows[0].count, String(count));
}

test('equal concurrent bids have exactly one funded winner', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1'); await f.deposit('bidder2');
  const lock = await holdAuction(a);
  let requests;
  try {
    requests = [place(a), place(a, '100', 'bidder2')];
    await waitBlocked(f.pool, lock.pid, 2);
  } finally { await lock.release(); }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await responses.find((r) => r.status === 409).json()).error.code, 'BID_TOO_LOW');
  await invariants(a, 1);
});

test('11000 queued before 12000 after 10000 accepts both with contiguous sequence', async () => {
  const a = await f.createAuction({ startingBidCents: 10000n, minIncrementCents: 1000n });
  await f.deposit('bidder1'); await f.deposit('bidder2');
  assert.equal((await place(a, '10000', 'bidder1')).status, 201);
  const lock = await holdAuction(a);
  let lower, higher;
  try {
    lower = place(a, '11000', 'bidder2');
    const [lowerPid] = await waitBlocked(f.pool, lock.pid);
    higher = place(a, '12000', 'bidder1');
    await waitBlocked(f.pool, lowerPid);
  } finally { await lock.release(); }
  assert.equal((await lower).status, 201); assert.equal((await higher).status, 201);
  await invariants(a, 3);
  const reserved = (await f.pool.query('SELECT reserved_cents::text FROM wallets WHERE user_id=$1', [f.users.bidder1])).rows[0].reserved_cents;
  assert.equal(reserved, '12000');
});

test('23 same-user distinct-key concurrent bids create only one effect', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1');
  const lock = await holdAuction(a);
  let requests;
  try {
    requests = Array.from({ length: 23 }, () => place(a));
    await waitBlocked(f.pool, lock.pid, 5);
  } finally { await lock.release(); }
  const responses = await Promise.all(requests);
  assert.equal(responses.filter((r) => r.status === 201).length, 1);
  for (const r of responses.filter((r) => r.status !== 201)) {
    assert.equal(r.status, 409); assert.equal((await r.json()).error.code, 'ALREADY_LEADING');
  }
  await invariants(a, 1);
});

test('same-key concurrent retries share one immutable receipt and changed payload conflicts', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1');
  const lock = await holdAuction(a);
  let requests;
  try {
    requests = Array.from({ length: 6 }, () => place(a, '100', 'bidder1', 'same'));
    await waitBlocked(f.pool, lock.pid, 5);
  } finally { await lock.release(); }
  const responses = await Promise.all(requests);
  const receipts = await Promise.all(responses.map(async (r) => { assert.equal(r.status, 201); return r.json(); }));
  receipts.forEach((r) => assert.deepEqual(r, receipts[0]));
  const conflict = await place(a, '110', 'bidder1', 'same');
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  await invariants(a, 1);
});

test('concurrent same key with different amounts accepts one fingerprint and rejects the other', async () => {
  const a = await f.createAuction(); await f.deposit('bidder1');
  const lock = await holdAuction(a);
  let requests;
  try {
    requests = [place(a, '100', 'bidder1', 'conflict'), place(a, '110', 'bidder1', 'conflict')];
    await waitBlocked(f.pool, lock.pid, 2);
  } finally { await lock.release(); }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await responses.find((r) => r.status === 409).json()).error.code, 'IDEMPOTENCY_CONFLICT');
  await invariants(a, 1);
});

test('two auctions cannot concurrently reserve more than their shared wallet balance', async () => {
  const a = await f.createAuction(), b = await f.createAuction(); await f.deposit('bidder1', '150');
  const lock = await holdWallet('bidder1');
  let requests;
  try {
    requests = [place(a), place(b)];
    await waitBlocked(f.pool, lock.pid, 2);
  } finally { await lock.release(); }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await responses.find((r) => r.status === 409).json()).error.code, 'INSUFFICIENT_FUNDS');
  await invariants(a, responses[0].status === 201 ? 1 : 0);
  await invariants(b, responses[1].status === 201 ? 1 : 0);
  assert.equal((await f.pool.query('SELECT reserved_cents::text FROM wallets WHERE user_id=$1', [f.users.bidder1])).rows[0].reserved_cents, '100');
});

for (const kind of ['auction', 'wallet']) {
  test(`bid rechecks DB time after ${kind} lock wait and rejects expiration without extending`, async () => {
    const a = await f.createAuction({ endsAt: new Date(+(await f.clock()) + 800) }); await f.deposit('bidder1');
    const lock = kind === 'auction' ? await holdAuction(a) : await holdWallet('bidder1');
    let pending;
    try {
      pending = place(a);
      await waitBlocked(f.pool, lock.pid);
      await waitDatabaseDeadline(f.pool, a.endsAt);
    } finally { await lock.release(); }
    const response = await pending;
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'AUCTION_NOT_LIVE');
    await invariants(a, 0);
    const end = (await f.pool.query(`SELECT to_char(ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value FROM auctions WHERE id=$1`, [a.id])).rows[0].value;
    assert.equal(end, a.endsAt);
  });
}

test('bid waiting behind a concurrent deposit sees its committed credit and balanced ledger', async () => {
  const a = await f.createAuction();
  const lock = await holdWallet('bidder1');
  let credit, bid;
  try {
    credit = f.deposit('bidder1', '100');
    const [creditPid] = await waitBlocked(f.pool, lock.pid);
    bid = place(a);
    await waitBlocked(f.pool, creditPid);
  } finally { await lock.release(); }
  await credit;
  assert.equal((await bid).status, 201);
  await invariants(a, 1);
  assert.equal((await f.pool.query('SELECT sum(amount_cents)::text AS total,count(*) FROM ledger_entries')).rows[0].total, '0');
  assert.equal((await f.pool.query('SELECT count(*) FROM ledger_entries')).rows[0].count, '2');
});

test('crossed previous and new leaders lock wallet UUIDs consistently without a deadlock', async () => {
  const a = await f.createAuction(), b = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  assert.equal((await place(a)).status, 201);
  assert.equal((await place(b, '100', 'bidder2')).status, 201);
  const ids = [await walletId('bidder1'), await walletId('bidder2')].sort();
  const lock = await holdRow(f.pool, 'SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [ids[0]]);
  let requests;
  try {
    requests = [place(a, '110', 'bidder2'), place(b, '110', 'bidder1')];
    await waitBlocked(f.pool, lock.pid, 2);
  } finally { await lock.release(); }
  const responses = await Promise.all(requests);
  responses.forEach((r) => assert.equal(r.status, 201));
  await invariants(a, 2); await invariants(b, 2);
  const reserved = (await f.pool.query('SELECT reserved_cents::text FROM wallets WHERE user_id=ANY($1::uuid[])', [[f.users.bidder1, f.users.bidder2]])).rows;
  assert.deepEqual(reserved.map((r) => r.reserved_cents), ['110', '110']);
});
