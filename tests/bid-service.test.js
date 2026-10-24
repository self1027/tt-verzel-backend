import assert from 'node:assert/strict';
import { test } from 'node:test';

test('legitimate replay is returned before current deadline/history/funds validation', async () => {
  const { BidService } = await import('../src/modules/bids/services/bid-service.ts');
  const { bidFingerprint } = await import('../src/modules/bids/domain/idempotency.ts');
  const result = { id: 'original', amountCents: '1000', endsAt: 'original-end' };
  const tx = {
    lockAuction: async () => ({ id: 'auction', status: 'SETTLED' }),
    databaseNow: async () => new Date(),
    actor: async () => ({ id: 'user', role: 'BIDDER' }),
    operations: { find: async () => ({ fingerprint: bidFingerprint(1000n), result }) },
    history: () => assert.fail('replay must not read history'),
    lockWallets: () => assert.fail('replay must not lock wallets'),
  };
  const bids = new BidService({ transaction: (work) => work(tx) }, {});
  assert.equal(await bids.placeBid('user', 'auction', 1000n, 'retry'), result);
  await assert.rejects(bids.placeBid('user', 'auction', 2000n, 'retry'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('internal callers cannot bypass amount/key validation or BIDDER authorization', async () => {
  const { BidService } = await import('../src/modules/bids/services/bid-service.ts');
  const tx = { lockAuction: async () => ({ id: 'auction' }), databaseNow: async () => new Date(), actor: async () => ({ id: 'user', role: 'AUCTIONEER' }) };
  const bids = new BidService({ transaction: (work) => work(tx) }, {});
  await assert.rejects(bids.placeBid('user', 'auction', 0n, 'key'), { status: 400 });
  await assert.rejects(bids.placeBid('user', 'auction', 1000n, ''), { status: 400 });
  await assert.rejects(bids.placeBid('user', 'auction', 1000n, 'key'), { status: 403 });
});
