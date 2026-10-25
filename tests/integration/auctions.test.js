import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import { auctionFixture } from '../helpers/auctions.js';
import { lifecycleState } from '../../src/modules/auctions/lifecycle.ts';
import { AuctionService } from '../../src/modules/auctions/services/auction-service.ts';
import { DrizzleAuctionRepository } from '../../src/modules/auctions/repositories/drizzle-auction-repository.ts';

let f;
before(async () => { f = await auctionFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });

async function create(input = {}, token = f.tokens.owner) {
  return f.request('', { method: 'POST', token, body: await f.payload(input) });
}
async function patch(id, body, token = f.tokens.owner) {
  return f.request(`/${id}`, { method: 'PATCH', token, body });
}
async function cancel(id, token = f.tokens.owner) {
  return f.request(`/${id}/cancel`, { method: 'POST', token });
}

test('AUCTIONEER creates a local snapshot lot with published status, null bid and precise BIGINT strings', async () => {
  const before = await f.pool.query('SELECT * FROM product_snapshots WHERE id = $1', [f.snapshotId]);
  const response = await create({ startingBidCents: '9223372036854775807', minIncrementCents: '9007199254740993' });
  assert.equal(response.status, 201);
  const { auction } = await response.json();
  assert.equal(auction.auctioneerId, f.ownerId);
  assert.equal(auction.status, 'PUBLISHED');
  assert.equal(auction.lifecycleState, 'SCHEDULED');
  assert.equal(auction.currentBidId, null);
  assert.equal(auction.startingBidCents, '9223372036854775807');
  assert.equal(auction.minIncrementCents, '9007199254740993');
  assert.equal(auction.productSnapshot.id, f.snapshotId);
  assert.deepEqual((await f.pool.query('SELECT * FROM product_snapshots WHERE id = $1', [f.snapshotId])).rows, before.rows);
  const stored = await f.pool.query('SELECT starting_bid_cents, min_increment_cents FROM auctions WHERE id = $1', [auction.id]);
  assert.equal(stored.rows[0].starting_bid_cents, '9223372036854775807');
});

test('creation requires authentication and AUCTIONEER', async () => {
  assert.equal((await create({}, null)).status, 401);
  assert.equal((await create({}, f.tokens.bidder)).status, 403);
});

test('creation accepts only existing local snapshot UUIDs', async () => {
  assert.equal((await create({ productSnapshotId: randomUUID() })).status, 404);
  assert.equal((await create({ productSnapshotId: 1 })).status, 400);
  assert.equal((await create({ productSnapshotId: '1' })).status, 400);
});

test('monetary values reject numbers, zero, negative, noncanonical, fractional and overflowing inputs', async () => {
  for (const value of [0, 1, 9007199254740992, '0', '-1', '01', '1.5', 'abc', '9223372036854775808', '', null, true]) {
    for (const field of ['startingBidCents', 'minIncrementCents']) {
      assert.equal((await create({ [field]: value })).status, 400, `${field}=${String(value)}`);
    }
  }
});

test('creation rejects invalid dates, missing timezone, elapsed starts and inverted ranges', async () => {
  const good = await f.payload();
  for (const change of [
    { startsAt: 'invalid' }, { startsAt: good.startsAt.replace('Z', '') },
    { endsAt: good.endsAt.replace('Z', '') }, { startsAt: '2020-01-01T00:00:00Z' },
    { endsAt: good.startsAt }, { endsAt: new Date(Date.parse(good.startsAt) - 1).toISOString() },
    { startsAt: '2030-02-30T12:00:00Z' }, { startsAt: '2030-01-01T12:00:00.123456Z' },
  ]) assert.equal((await create(change)).status, 400, JSON.stringify(change));
  const starts = new Date(Date.parse(good.startsAt) - 3 * 3600000).toISOString().replace('Z', '-03:00');
  const response = await create({ startsAt: starts, endsAt: good.endsAt });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).auction.startsAt, good.startsAt);
});

test('creation rejects server-controlled and extra fields', async () => {
  for (const field of ['id', 'auctioneerId', 'currentBidId', 'status', 'lifecycleState', 'createdAt', 'updatedAt', 'price']) {
    assert.equal((await create({ [field]: 'injected' })).status, 400, field);
  }
});

test('list and details are public and expose snapshot data without user credentials', async () => {
  const auction = await f.fixture();
  const list = await f.request();
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.total, 1);
  assert.equal(body.auctions[0].productSnapshot.id, f.snapshotId);
  assert.ok(body.asOf);
  const details = await f.request(`/${auction.id}`);
  assert.equal(details.status, 200);
  const text = await details.text();
  for (const secret of ['passwordHash', 'password_hash', 'email', 'wallet']) assert.ok(!text.includes(secret));
  assert.equal((await f.request(`/${randomUUID()}`)).status, 404);
  assert.equal((await f.request('/not-a-uuid')).status, 400);
});

test('mine is authenticated, role-restricted and isolated by actual owner', async () => {
  const owned = await f.fixture();
  await f.fixture({ auctioneerId: f.otherId });
  assert.equal((await f.request('/mine')).status, 401);
  assert.equal((await f.request('/mine', { token: f.tokens.bidder })).status, 403);
  const body = await (await f.request('/mine', { token: f.tokens.owner })).json();
  assert.equal(body.total, 1);
  assert.equal(body.auctions[0].id, owned.id);
  assert.equal((await f.request()).status, 200);
});

test('owner edits future published lots with merged validation and updatedAt', async () => {
  const auction = await f.fixture({ updatedAt: new Date('2020-01-01T00:00:00Z') });
  const response = await patch(auction.id, { startingBidCents: '9007199254740993' });
  assert.equal(response.status, 200);
  const edited = (await response.json()).auction;
  assert.equal(edited.startingBidCents, '9007199254740993');
  assert.equal(edited.minIncrementCents, '100');
  assert.equal(edited.status, 'PUBLISHED');
  assert.ok(Date.parse(edited.updatedAt) > +auction.updatedAt);
  assert.equal((await patch(auction.id, { endsAt: auction.startsAt.toISOString() })).status, 400);
  assert.equal((await patch(auction.id, { startsAt: '2020-01-01T00:00:00Z' })).status, 400);
  assert.equal((await patch(auction.id, {})).status, 400);
  for (const field of ['auctioneerId', 'productSnapshotId', 'status', 'currentBidId', 'id', 'updatedAt']) {
    assert.equal((await patch(auction.id, { [field]: randomUUID() })).status, 400);
  }
});

test('ownership and role checks protect editing and cancellation', async () => {
  const auction = await f.fixture();
  assert.equal((await patch(auction.id, { startingBidCents: '1' }, f.tokens.other)).status, 403);
  assert.equal((await cancel(auction.id, f.tokens.other)).status, 403);
  assert.equal((await patch(auction.id, { startingBidCents: '1' }, f.tokens.bidder)).status, 403);
  assert.equal((await cancel(auction.id, f.tokens.bidder)).status, 403);
  assert.equal((await patch(auction.id, { startingBidCents: '1' }, null)).status, 401);
  assert.equal((await cancel(auction.id, null)).status, 401);
  assert.equal((await patch(randomUUID(), { startingBidCents: '1' })).status, 404);
  assert.equal((await cancel(randomUUID())).status, 404);
});

test('editing is forbidden once started, in terminal states or with actual bids even without currentBidId', async () => {
  const now = await f.clock();
  const live = await f.fixture({ startsAt: new Date(+now - 60000) });
  assert.equal((await patch(live.id, { startingBidCents: '1' })).status, 409);
  for (const status of ['CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']) {
    const auction = await f.fixture({ status });
    assert.equal((await patch(auction.id, { startingBidCents: '1' })).status, 409);
  }
  const withBid = await f.fixture();
  await f.addBid(withBid.id);
  assert.equal((await patch(withBid.id, { startingBidCents: '1' })).status, 409);
});

test('owner can cancel scheduled or LIVE lots without bids; repeats return 409 without further mutation', async () => {
  const now = await f.clock();
  for (const startsAt of [new Date(+now + 60000), new Date(+now - 60000)]) {
    const auction = await f.fixture({ startsAt });
    const response = await cancel(auction.id);
    assert.equal(response.status, 200);
    const cancelled = (await response.json()).auction;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.lifecycleState, 'CANCELLED');
    const repeated = await cancel(auction.id);
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).error.code, 'AUCTION_NOT_PUBLISHED');
    assert.equal((await (await f.request(`/${auction.id}`)).json()).auction.updatedAt, cancelled.updatedAt);
  }
});

test('cancellation rejects bids, ended windows, terminal states and unexpected request bodies', async () => {
  const withBid = await f.fixture();
  await f.addBid(withBid.id);
  assert.equal((await cancel(withBid.id)).status, 409);
  const now = await f.clock();
  const expired = await f.fixture({ startsAt: new Date(+now - 120000), endsAt: new Date(+now - 60000) });
  assert.equal((await cancel(expired.id)).status, 409);
  for (const status of ['CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']) {
    const auction = await f.fixture({ status });
    assert.equal((await cancel(auction.id)).status, 409);
  }
  const scheduled = await f.fixture();
  assert.equal((await f.request(`/${scheduled.id}/cancel`, { method: 'POST', token: f.tokens.owner, body: { status: 'SETTLED' } })).status, 400);
});

test('SQL lifecycle filters precede pagination and counts, with deterministic ordering and one asOf', async () => {
  const now = await f.clock();
  const all = [];
  for (const state of ['SCHEDULED', 'LIVE', 'FINALIZING', 'CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']) {
    for (let i = 0; i < 2; i++) {
      const status = ['SCHEDULED', 'LIVE', 'FINALIZING'].includes(state) ? 'PUBLISHED' : state;
      all.push(await f.fixture({ status, createdAt: now, startsAt: new Date(+now + (state === 'SCHEDULED' ? 60000 : -120000)), endsAt: new Date(+now + (state === 'FINALIZING' ? -60000 : 120000)) }));
    }
    const response = await f.request(`?lifecycleState=${state}&limit=1&skip=1`);
    const page = await response.json();
    assert.equal(response.status, 200);
    if (state === 'CANCELLED') {
      assert.equal(page.total, 0); assert.deepEqual(page.auctions, []); continue;
    }
    assert.equal(page.total, 2);
    assert.equal(page.auctions.length, 1);
    assert.equal(page.auctions[0].lifecycleState, state);
    assert.equal(lifecycleState({ ...page.auctions[0], startsAt: new Date(page.auctions[0].startsAt), endsAt: new Date(page.auctions[0].endsAt) }, new Date(page.asOf)), state);
  }
  const page = await (await f.request('?limit=3&skip=2')).json();
  assert.equal(page.total, 10);
  assert.deepEqual(page.auctions.map((auction) => auction.id), all.filter(auction => auction.status !== 'CANCELLED').map((auction) => auction.id).sort().slice(2, 5));
  for (const query of ['limit=0', 'limit=101', 'skip=-1', 'limit=1&limit=2', 'lifecycleState=PUBLISHED', 'auctioneerId=other']) {
    assert.equal((await f.request(`?${query}`)).status, 400, query);
  }
});

test('public snapshot queries work with every external network access blocked', async () => {
  const auction = await f.fixture();
  const original = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = (url, options) => {
    if (!String(url).startsWith(f.url + '/')) { externalCalls++; throw new Error('External services unavailable'); }
    return original(url, options);
  };
  try {
    assert.equal((await f.request()).status, 200);
    const response = await f.request(`/${auction.id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).auction.productSnapshot.title, 'Local snapshot');
    assert.equal(externalCalls, 0);
  } finally { globalThis.fetch = original; }
});

test('UTC storage and lifecycle queries remain correct with a non-UTC PostgreSQL session', async () => {
  const client = await f.pool.connect();
  try {
    await client.query("SET TIME ZONE 'America/Sao_Paulo'");
    const service = new AuctionService(new DrizzleAuctionRepository(drizzle({ client })));
    const input = await f.payload();
    const created = await service.create(f.ownerId, { ...input, startingBidCents: 1n, minIncrementCents: 1n, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt) });
    assert.equal(created.startsAt.toISOString(), input.startsAt);
    assert.equal((await service.get(created.id)).startsAt.toISOString(), input.startsAt);
    const page = await service.list({ limit: 30, skip: 0, lifecycleState: 'SCHEDULED' });
    assert.equal(page.total, 1);
    assert.equal(page.auctions[0].id, created.id);
    const stored = await client.query('SELECT starts_at::text AS start FROM auctions WHERE id = $1', [created.id]);
    assert.equal(stored.rows[0].start.slice(0, 19).replace(' ', 'T'), input.startsAt.slice(0, 19));
  } finally {
    await client.query('SET TIME ZONE DEFAULT');
    client.release();
  }
});
