import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBid, validateHistory } from '../src/modules/bids/domain/bid-rules.ts';
import { MAX_CENTS } from '../src/modules/ledger/contracts/ledger.ts';

const now = new Date('2026-10-24T12:00:00Z');
const auction = (changes = {}) => ({ id: 'auction', status: 'PUBLISHED', currentBidId: null,
  startingBidCents: 100n, minIncrementCents: 10n,
  startsAt: new Date(+now - 1000), endsAt: new Date(+now + 300000), ...changes });
const bid = (changes = {}) => ({ id: 'bid-1', auctionId: 'auction', bidderId: 'other',
  amountCents: 100n, sequence: 1n, createdAt: now, ...changes });
const conflict = (action) => assert.throws(action, { status: 409 });

test('accepts first bid at the exact starting price and start instant', () => {
  const a = auction({ startsAt: now });
  assert.deepEqual(validateBid(a, null, 'user', 100n, now), a.endsAt);
  assert.throws(() => validateBid(a, null, 'user', 99n, now), { code: 'BID_TOO_LOW' });
});

test('requires PUBLISHED and startsAt <= now < endsAt', () => {
  for (const status of ['CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']) {
    conflict(() => validateBid(auction({ status }), null, 'user', 100n, now));
  }
  for (const changes of [{ startsAt: new Date(+now + 1) }, { endsAt: now }, { endsAt: new Date(+now - 1) }]) {
    conflict(() => validateBid(auction(changes), null, 'user', 100n, now));
  }
});

test('requires next exact increment and rejects the current leader', () => {
  const a = auction({ currentBidId: 'bid-1' });
  assert.deepEqual(validateBid(a, bid(), 'user', 110n, now), a.endsAt);
  assert.throws(() => validateBid(a, bid(), 'user', 109n, now), { code: 'BID_TOO_LOW' });
  assert.throws(() => validateBid(a, bid(), 'other', 110n, now), { code: 'ALREADY_LEADING' });
});

test('anti-sniping uses the old deadline at the inclusive 120000ms boundary', () => {
  for (const remaining of [1, 119999, 120000, 120001]) {
    const a = auction({ endsAt: new Date(+now + remaining) });
    assert.equal(+validateBid(a, null, 'user', 100n, now), +a.endsAt + (remaining <= 120000 ? 120000 : 0));
  }
});

test('successive anti-sniping extensions each add two minutes to the preceding deadline', () => {
  const a = auction({ endsAt: new Date(+now + 60000) });
  const firstEnd = validateBid(a, null, 'user', 100n, now);
  const secondEnd = validateBid({ ...a, currentBidId: 'bid-1', endsAt: firstEnd }, bid(), 'user', 110n, new Date(+now + 70000));
  assert.equal(+firstEnd, +a.endsAt + 120000);
  assert.equal(+secondEnd, +firstEnd + 120000);
  assert.equal(+a.endsAt, +now + 60000);
});

test('enforces BIGINT amount and increment limits without number conversion', () => {
  for (const amount of [0n, -1n, MAX_CENTS + 1n, 100, '100']) {
    assert.throws(() => validateBid(auction(), null, 'user', amount, now), { status: 400, code: 'INVALID_AMOUNT' });
  }
  const a = auction({ currentBidId: 'bid-1', minIncrementCents: 1n });
  assert.doesNotThrow(() => validateBid(a, bid({ amountCents: MAX_CENTS - 1n }), 'user', MAX_CENTS, now));
  conflict(() => validateBid(a, bid({ amountCents: MAX_CENTS }), 'user', MAX_CENTS, now));
  conflict(() => validateBid(a, bid({ sequence: MAX_CENTS }), 'user', 110n, now));
});

test('fails safely on invalid dates, date overflow, and corrupt auction terms', () => {
  for (const changes of [{ startsAt: new Date(NaN) }, { endsAt: new Date(NaN) },
    { startingBidCents: 0n }, { minIncrementCents: MAX_CENTS + 1n }]) {
    conflict(() => validateBid(auction(changes), null, 'user', 100n, now));
  }
  conflict(() => validateBid(auction(), null, 'user', 100n, new Date(NaN)));
  const end = new Date(8640000000000000);
  conflict(() => validateBid(auction({ endsAt: end }), null, 'user', 100n, new Date(+end - 1)));
});

test('history returns null for no bids and the latest bid for contiguous history', () => {
  assert.equal(validateHistory(auction(), []), null);
  const latest = bid({ id: 'bid-2', sequence: 2n, bidderId: 'user', amountCents: 110n });
  assert.equal(validateHistory(auction({ currentBidId: latest.id }), [bid(), latest]), latest);
});

test('history rejects missing, stale or unexpected current pointers', () => {
  conflict(() => validateHistory(auction({ currentBidId: 'bid-1' }), []));
  conflict(() => validateHistory(auction(), [bid()]));
  conflict(() => validateHistory(auction({ currentBidId: 'missing' }), [bid()]));
});

test('history rejects gaps, duplicate ids, foreign auctions and malformed bid fields', () => {
  const a = auction({ currentBidId: 'bid-1' });
  for (const changes of [{ sequence: 0n }, { sequence: 2n }, { sequence: MAX_CENTS + 1n },
    { sequence: 1 }, { amountCents: 0n }, { amountCents: MAX_CENTS + 1n },
    { amountCents: 100 }, { auctionId: 'other' }, { bidderId: '' }, { id: '' }, { createdAt: new Date(NaN) }]) {
    conflict(() => validateHistory(a, [bid(changes)]));
  }
  conflict(() => validateHistory(a, [bid(), bid({ sequence: 2n, amountCents: 110n })]));
});

test('bid validation rejects an inconsistent current pointer or corrupt current bid', () => {
  conflict(() => validateBid(auction(), bid(), 'user', 110n, now));
  conflict(() => validateBid(auction({ currentBidId: 'bid-1' }), null, 'user', 110n, now));
  conflict(() => validateBid(auction({ currentBidId: 'bid-1' }), bid({ auctionId: 'other' }), 'user', 110n, now));
});

test('history rejects prices below the historical minimum or consecutive self-overbids', () => {
  conflict(() => validateHistory(auction({ currentBidId: 'bid-1' }), [bid({ amountCents: 99n })]));
  const a = auction({ currentBidId: 'bid-2' });
  for (const changes of [{ amountCents: 99n }, { amountCents: 109n }, { bidderId: 'other' }]) {
    conflict(() => validateHistory(a, [bid(), bid({ id: 'bid-2', sequence: 2n, bidderId: 'user', amountCents: 110n, ...changes })]));
  }
});

test('history rejects decreasing timestamps while accepting equal timestamps', () => {
  const a = auction({ currentBidId: 'bid-2' });
  const latest = bid({ id: 'bid-2', sequence: 2n, bidderId: 'user', amountCents: 110n });
  assert.equal(validateHistory(a, [bid(), latest]), latest);
  conflict(() => validateHistory(a, [bid(), { ...latest, createdAt: new Date(+now - 1) }]));
});
