import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { auctionFixture } from '../helpers/auctions.js';

let f;
before(async () => { f = await auctionFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });

async function page(query = '', mine = false) {
  const response = await f.request(`${mine ? '/mine' : ''}?${query}`, mine ? { token: f.tokens.owner } : {});
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function bid(auction, amount) {
  const id = randomUUID();
  await f.pool.query('INSERT INTO bids (id, auction_id, bidder_id, amount_cents, sequence, created_at) VALUES ($1,$2,$3,$4,1,now())', [id, auction.id, f.bidderId, amount]);
  await f.pool.query('UPDATE auctions SET current_bid_id = $1 WHERE id = $2', [id, auction.id]);
  return id;
}

test('combined local title, lifecycle, precise current price, sorting and page filter before count', async () => {
  const now = await f.clock();
  const a = await f.fixture({ startingBidCents: 9007199254740993n, createdAt: now });
  const b = await f.fixture({ startingBidCents: 1000n, createdAt: now });
  await bid(b, '9007199254740994');
  await f.fixture({ startingBidCents: 9007199254740992n });
  await f.fixture({ startingBidCents: 9007199254740993n, status: 'CANCELLED' });
  const query = 'q=LOCAL&lifecycleState=SCHEDULED&minPriceCents=9007199254740993&maxPriceCents=9007199254740994&sort=price_desc&limit=1&page=2';
  const result = await page(query);
  assert.equal(result.total, 2);
  assert.equal(result.skip, 1);
  assert.equal(result.auctions[0].id, a.id);
  assert.equal(result.auctions[0].startingBidCents, '9007199254740993');
  const first = await page(query.replace('page=2', 'page=1'));
  assert.equal(first.auctions[0].id, b.id);
  assert.equal((await page('minPriceCents=9007199254740994&maxPriceCents=9007199254740994')).total, 1);
});

test('q treats percent, underscore and backslash literally against snapshot title', async () => {
  await f.fixture();
  const snapshot = randomUUID();
  await f.pool.query("INSERT INTO product_snapshots (id,external_id,source,title,captured_at) VALUES ($1,'escaped','test',$2,now())", [snapshot, 'Offer 10%_\\ special']);
  const match = await f.fixture({ productSnapshotId: snapshot });
  for (const q of ['%', '_', '\\', '10%_\\', 'offer']) {
    const result = await page(`q=${encodeURIComponent(q)}`);
    assert.equal(result.total, 1, q);
    assert.equal(result.auctions[0].id, match.id);
  }
});

test('sorts use stable id ties and mine retains owner scope with all filters', async () => {
  const now = await f.clock();
  const a = await f.fixture({ createdAt: now, endsAt: new Date(+now + 10000000) });
  const b = await f.fixture({ createdAt: now, endsAt: a.endsAt });
  const other = await f.fixture({ createdAt: now, auctioneerId: f.otherId, startingBidCents: 1500n, endsAt: new Date(+a.endsAt + 60000) });
  const ties = [a.id, b.id].sort();
  assert.deepEqual((await page('sort=price_asc')).auctions.map((x) => x.id), [...ties, other.id]);
  assert.deepEqual((await page('sort=price_desc')).auctions.map((x) => x.id), [other.id, ...ties]);
  assert.deepEqual((await page('sort=endsAt_asc')).auctions.map((x) => x.id), [...ties, other.id]);
  assert.deepEqual((await page('sort=endsAt_desc')).auctions.map((x) => x.id), [other.id, ...ties]);
  const mine = await page('q=local&minPriceCents=1000&maxPriceCents=1500&lifecycleState=SCHEDULED&sort=price_desc&limit=1&page=2', true);
  assert.equal(mine.total, 2);
  assert.equal(mine.auctions[0].id, ties[1]);
});

test('foreign current bid cannot change auction price and defaults exclude cancelled lots and preserve historical direct access', async () => {
  const now = await f.clock();
  const a = await f.fixture({ startingBidCents: 1000n, createdAt: now, status: 'CANCELLED' });
  const b = await f.fixture({ startingBidCents: 2000n, createdAt: now });
  const foreign = await bid(b, '9223372036854775807');
  await f.pool.query('UPDATE auctions SET current_bid_id = $1 WHERE id = $2', [foreign, a.id]);
  const filtered = await page('minPriceCents=1000&maxPriceCents=1000');
  assert.equal(filtered.total, 0);
  assert.equal((await (await f.request(`/${a.id}`)).json()).auction.id, a.id);
  const result = await page('limit=1');
  assert.equal(result.total, 1);
  assert.equal(result.auctions[0].id, b.id);
  assert.deepEqual(Object.keys(result).sort(), ['asOf', 'auctions', 'limit', 'skip', 'total']);
});

test('HTTP rejects repeated, unknown, overflowing and contradictory query filters', async () => {
  for (const query of ['q=x&q=y', 'sort=x', 'page=0', 'page=1&skip=0', 'page=2147483649&limit=1', 'minPriceCents=2&maxPriceCents=1', 'minPriceCents=01', 'maxPriceCents=9223372036854775808', 'price=1']) {
    assert.equal((await f.request(`?${query}`)).status, 400, query);
  }
});
