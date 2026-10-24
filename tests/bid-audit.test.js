import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { checkOperational } from '../src/modules/audit/services/operational-integrity.ts';

function snapshot(createdAt, resultingEndsAt) {
  const auctionId = randomUUID();
  const auction = { productSnapshotId: randomUUID(), startingBidCents: '100', minIncrementCents: '10',
    startsAt: '2026-10-24T11:00:00.000Z', endsAt: '2026-10-24T12:00:00.000Z', status: 'PUBLISHED', currentBidId: null };
  const bid = { bidId: randomUUID(), bidderRef: 'a'.repeat(64), amountCents: '100', bidSequence: '1', createdAt };
  return { auctionId, events: [
    { eventType: 'AUCTION_CREATED', sequence: 1n, createdAt: '2026-10-24T10:00:00.000Z', payload: auction },
    { eventType: 'BID_ACCEPTED', sequence: 2n, createdAt, payload: { ...bid, endsAt: resultingEndsAt } },
  ], operational: { auction: { ...auction, currentBidId: bid.bidId, endsAt: resultingEndsAt }, bids: [bid], settlement: null } };
}

test('audit replay enforces old deadline plus exactly two minutes at the inclusive sniping boundary', () => {
  assert.equal(checkOperational(snapshot('2026-10-24T11:58:00.000Z', '2026-10-24T12:02:00.000Z')).consistent, true);
  assert.equal(checkOperational(snapshot('2026-10-24T11:58:00.000Z', '2026-10-24T12:00:00.000Z')).consistent, false);
  assert.equal(checkOperational(snapshot('2026-10-24T11:59:30.000Z', '2026-10-24T12:01:30.000Z')).consistent, false);
  assert.equal(checkOperational(snapshot('2026-10-24T11:59:59.999Z', '2026-10-24T12:02:00.001Z')).consistent, false);
});
test('audit replay forbids deadline extension outside the sniping window', () => {
  assert.equal(checkOperational(snapshot('2026-10-24T11:57:59.999Z', '2026-10-24T12:00:00.000Z')).consistent, true);
  assert.equal(checkOperational(snapshot('2026-10-24T11:57:59.999Z', '2026-10-24T12:02:00.000Z')).consistent, false);
});
test('successive near-end bids extend the most recently committed deadline', () => {
  const value = snapshot('2026-10-24T11:59:30.000Z', '2026-10-24T12:02:00.000Z');
  const second = { bidId: randomUUID(), bidderRef: 'b'.repeat(64), amountCents: '110', bidSequence: '2', createdAt: '2026-10-24T12:01:00.000Z' };
  value.events.push({ eventType: 'BID_ACCEPTED', sequence: 3n, createdAt: second.createdAt, payload: { ...second, endsAt: '2026-10-24T12:04:00.000Z' } });
  value.operational.bids.push(second);
  value.operational.auction.currentBidId = second.bidId;
  value.operational.auction.endsAt = '2026-10-24T12:04:00.000Z';
  assert.equal(checkOperational(value).consistent, true);
  value.events[2].payload.endsAt = '2026-10-24T12:03:00.000Z';
  value.operational.auction.endsAt = '2026-10-24T12:03:00.000Z';
  assert.equal(checkOperational(value).consistent, false);
});
