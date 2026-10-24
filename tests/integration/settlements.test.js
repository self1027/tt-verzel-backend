import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { settlementFixture } from '../helpers/settlements.js';
let f;
before(async () => { f = await settlementFixture(); });
beforeEach(async () => { await f.reset(); });
after(async () => { await f?.close(); });

test('winner settlement captures exactly once, credits seller and appends audit/outbox atomically', async () => {
  const auction = await f.expiredAuction();
  const result = await f.settlementService.settle(auction.id);
  assert.equal(result.status, 'SETTLED');
  const balances = (await f.pool.query('SELECT user_id,balance_cents::text,reserved_cents::text FROM wallets')).rows;
  assert.deepEqual(balances.find(row => row.user_id === f.users.bidder1), { user_id: f.users.bidder1, balance_cents: '99900', reserved_cents: '0' });
  assert.deepEqual(balances.find(row => row.user_id === f.users.auctioneer), { user_id: f.users.auctioneer, balance_cents: '100', reserved_cents: '0' });
  assert.equal((await f.pool.query("SELECT status FROM wallet_reservations")).rows[0].status, 'CAPTURED');
  assert.equal((await f.pool.query("SELECT count(*) FROM ledger_transactions WHERE type='AUCTION_SETTLEMENT'")).rows[0].count, '1');
  assert.equal((await f.pool.query("SELECT sum(amount_cents)::text AS sum FROM ledger_entries")).rows[0].sum, '0');
  assert.equal((await f.pool.query("SELECT event_type FROM audit_events ORDER BY sequence DESC LIMIT 1")).rows[0].event_type, 'AUCTION_SETTLED');
  assert.equal((await f.settlementService.settle(auction.id)).settlementId, result.settlementId);
  assert.equal((await f.pool.query('SELECT count(*) FROM auction_settlements')).rows[0].count, '1');
});

test('expired no-bid auction closes without financial entries or settlement receipt', async () => {
  const auction = await f.expiredAuction(false);
  assert.equal((await f.settlementService.settle(auction.id)).status, 'CLOSED_NO_BIDS');
  assert.equal((await f.pool.query('SELECT count(*) FROM ledger_transactions')).rows[0].count, '0');
  assert.equal((await f.pool.query('SELECT count(*) FROM auction_settlements')).rows[0].count, '0');
  assert.equal((await f.pool.query('SELECT status FROM auctions')).rows[0].status, 'CLOSED_NO_BIDS');
});
