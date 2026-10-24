import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';

let f;
before(async () => { f = await bidFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });
const place = (auction, amountCents = '100', options = {}) => f.request(`/${auction.id}/bids`, {
  method: 'POST', token: f.tokens.bidder1, key: 'bid-key', body: { amountCents }, ...options,
});

test('uppercase UUID routes normalize to the same canonical auction identity', async () => {
  const auction = await f.createAuction();
  await f.deposit('bidder1');
  const response = await f.request(`/${auction.id.toUpperCase()}/bids`, { method: 'POST', token: f.tokens.bidder1,
    key: 'uppercase', body: { amountCents: '100' } });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).bid.auctionId, auction.id);
});

test('public pagination rejects corrupted economic history outside the requested page', async () => {
  const auction = await f.createAuction();
  await f.deposit('bidder1'); await f.deposit('bidder2');
  assert.equal((await place(auction)).status, 201);
  assert.equal((await place(auction, '110', { token: f.tokens.bidder2 })).status, 201);
  await f.pool.query('UPDATE bids SET amount_cents=1 WHERE auction_id=$1 AND sequence=1', [auction.id]);
  assert.equal((await f.request(`/${auction.id}/bids?limit=1&skip=1`, { token: null })).status, 409);
});

test('auctioneers cannot bid on lots owned by another auctioneer either', async () => {
  const owner = randomUUID();
  await f.pool.query("INSERT INTO users SELECT $1,$2,password_hash,'Other auctioneer','AUCTIONEER',now(),now() FROM users WHERE id=$3",
    [owner, `${owner}@auction.test`, f.users.auctioneer]);
  const auction = await f.createAuction({ auctioneerId: owner });
  const response = await place(auction, '100', { token: f.tokens.auctioneer });
  assert.equal(response.status, 403);
  assert.equal((await f.pool.query('SELECT count(*) FROM bids')).rows[0].count, '0');
});

test('duplicate raw Idempotency-Key headers reject without accepting a bid', async () => {
  const auction = await f.createAuction();
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.url}/auctions/${auction.id}/bids`, { method: 'POST', headers: [
      'content-type', 'application/json', 'authorization', `Bearer ${f.tokens.bidder1}`,
      'Idempotency-Key', 'one', 'idempotency-key', 'two',
    ] }, (response) => { response.resume(); response.once('end', () => resolve(response)); });
    request.on('error', reject);
    request.end(JSON.stringify({ amountCents: '100' }));
  });
  assert.equal(response.statusCode, 400);
  assert.equal((await f.pool.query('SELECT count(*) FROM bids')).rows[0].count, '0');
});

test('bid endpoints enforce authentication, bidder role, strict amounts and keys', async () => {
  const auction = await f.createAuction();
  assert.equal((await place(auction, '100', { token: null })).status, 401);
  assert.equal((await place(auction, '100', { token: f.tokens.auctioneer })).status, 403);
  assert.equal((await f.request('/bids/mine', { token: null })).status, 401);
  assert.equal((await f.request('/bids/mine', { token: f.tokens.auctioneer })).status, 403);
  for (const amount of [0, null, '0', '-1', '01', '+1', ' 1', '1.5', '1e2', '9223372036854775808']) {
    assert.equal((await place(auction, amount)).status, 400, String(amount));
  }
  for (const key of [undefined, '', 'with spaces', 'x'.repeat(129)]) {
    assert.equal((await place(auction, '100', { key })).status, 400);
  }
  assert.equal((await place(auction, '100', { body: { amountCents: '100', userId: f.users.bidder2 } })).status, 400);
  assert.equal((await f.request('/invalid/bids', { token: null })).status, 400);
  assert.equal((await f.request(`/${randomUUID()}/bids`, { token: null })).status, 404);
});

test('public history exposes pseudonyms, stable ascending pages and immutable replay receipts', async () => {
  const auction = await f.createAuction({ startingBidCents: 100n, minIncrementCents: 10n });
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const firstResponse = await place(auction);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  const secondResponse = await place(auction, '110', { token: f.tokens.bidder2, key: 'second' });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  const retry = await place(auction);
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), first);
  const response = await f.request(`/${auction.id}/bids?limit=1&skip=0`, { token: null });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(page.bids, [Object.fromEntries(Object.entries(first.bid).filter(([key]) => key !== 'endsAt'))]);
  assert.equal(page.currentBid.id, second.bid.id);
  assert.equal(page.total, 2); assert.equal(page.limit, 1); assert.equal(page.skip, 0);
  assert.ok(Number.isFinite(Date.parse(page.asOf)));
  const text = JSON.stringify(page);
  for (const privateValue of [...Object.values(f.users), '@verzel.local', 'bid-key', 'walletId', 'bidderId']) assert.ok(!text.includes(privateValue));
  const next = await (await f.request(`/${auction.id}/bids?limit=1&skip=1`, { token: null })).json();
  assert.equal(next.bids[0].id, second.bid.id);
  assert.notEqual(first.bid.bidderRef, second.bid.bidderRef);
});

test('query pagination rejects repeated and unknown inputs for public history and mine', async () => {
  const auction = await f.createAuction();
  for (const path of [`/${auction.id}/bids`, '/bids/mine']) {
    for (const query of ['limit=0', 'limit=101', 'skip=-1', 'skip=2147483648', 'limit=1&limit=2', 'skip=0&skip=1', 'userId=x', 'limit=1.5']) {
      assert.equal((await f.request(`${path}?${query}`, { token: f.tokens.bidder1 })).status, 400, query);
    }
    const page = await (await f.request(path, { token: f.tokens.bidder1 })).json();
    assert.equal(page.limit, 30); assert.equal(page.skip, 0); assert.equal(page.total, 0);
  }
});

test('mine scopes authenticated ownership and deterministically orders tied timestamps by id', async () => {
  const a = await f.createAuction({ startingBidCents: 100n, minIncrementCents: 10n });
  const b = await f.createAuction({ startingBidCents: 100n, minIncrementCents: 10n });
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const first = (await (await place(a)).json()).bid;
  const other = (await (await place(a, '110', { token: f.tokens.bidder2 })).json()).bid;
  const second = (await (await place(b)).json()).bid;
  await f.pool.query('UPDATE bids SET created_at=$1', [new Date('2026-01-01T00:00:00Z')]);
  const page = await (await f.request('/bids/mine', { token: f.tokens.bidder1 })).json();
  assert.equal(page.total, 2);
  assert.deepEqual(page.bids.map(({ id }) => id), [first.id, second.id].sort());
  assert.equal(page.bids.find(({ id }) => id === first.id).isLeading, false);
  assert.equal(page.bids.find(({ id }) => id === second.id).isLeading, true);
  const otherPage = await (await f.request('/bids/mine', { token: f.tokens.bidder2 })).json();
  assert.deepEqual(otherPage.bids.map(({ id }) => id), [other.id]);
});

test('public history fails closed when the current pointer is stale or missing', async () => {
  const auction = await f.createAuction({ startingBidCents: 100n, minIncrementCents: 10n });
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const first = (await (await place(auction)).json()).bid;
  assert.equal((await place(auction, '110', { token: f.tokens.bidder2 })).status, 201);
  for (const pointer of [first.id, null]) {
    await f.pool.query('UPDATE auctions SET current_bid_id=$1 WHERE id=$2', [pointer, auction.id]);
    assert.equal((await f.request(`/${auction.id}/bids`, { token: null })).status, 409);
  }
});

test('public history rejects cross-auction pointers and corrupt public bid amounts', async () => {
  const a = await f.createAuction({ startingBidCents: 100n });
  const b = await f.createAuction({ startingBidCents: 100n });
  await f.deposit('bidder1');
  const first = (await (await place(a)).json()).bid;
  const foreign = (await (await place(b)).json()).bid;
  await f.pool.query('UPDATE auctions SET current_bid_id=$1 WHERE id=$2', [foreign.id, a.id]);
  assert.equal((await f.request(`/${a.id}/bids`, { token: null })).status, 409);
  await f.pool.query('UPDATE auctions SET current_bid_id=$1 WHERE id=$2', [first.id, a.id]);
  await f.pool.query('UPDATE bids SET amount_cents=0 WHERE id=$1', [first.id]);
  assert.equal((await f.request(`/${a.id}/bids`, { token: null })).status, 409);
});
