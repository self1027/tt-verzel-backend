import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { io } from 'socket.io-client';
import { settlementFixture } from '../helpers/settlements.js';
import { attachAuctionSockets } from '../../src/modules/realtime/auction-sockets.ts';
import { BidService } from '../../src/modules/bids/services/bid-service.ts';
import { DrizzleBidRepository } from '../../src/modules/bids/repositories/drizzle-bid-repository.ts';
import { DrizzleReservationOperations } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';
import { SettlementService } from '../../src/modules/settlements/services/settlement-service.ts';
import { DrizzleAuctionRepository } from '../../src/modules/auctions/repositories/drizzle-auction-repository.ts';
import { AuctionService } from '../../src/modules/auctions/services/auction-service.ts';

async function fixture(t) {
  const f = await settlementFixture();
  const server = createServer();
  const sockets = attachAuctionSockets(server, []);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = io(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], reconnection: false });
  await once(client, 'connect');
  t.after(async () => { client.disconnect(); await sockets.close(); await f.close(); });
  return { ...f, events: sockets.events, client };
}

test('real Socket.IO bid hints follow COMMIT; rolled-back outbids produce no hint', async t => {
  const f = await fixture(t);
  await f.deposit('bidder1'); await f.deposit('bidder2');
  const auction = await f.createAuction();
  await f.client.timeout(1000).emitWithAck('auction:join', { auctionId: auction.id });
  const received = [];
  f.client.on('bid:accepted', data => received.push(data));
  const repository = new DrizzleBidRepository(f.db, new DrizzleReservationOperations(), tx => new DrizzleAuditAppender(tx), f.events);
  const service = new BidService(repository, f.service);
  const notified = once(f.client, 'bid:accepted');
  const accepted = await service.placeBid(f.users.bidder1, auction.id, 100n, 'notify');
  const [event] = await notified;
  assert.equal(event.id, accepted.id);
  assert.equal((await f.pool.query('SELECT current_bid_id FROM auctions WHERE id=$1', [auction.id])).rows[0].current_bid_id, accepted.id);
  const failing = new BidService({ transaction: work => repository.transaction(tx => work({ ...tx,
    async appendAudit(bid, endsAt) { await tx.appendAudit(bid, endsAt); throw new Error('rollback before commit'); },
  })) }, f.service);
  await assert.rejects(failing.placeBid(f.users.bidder2, auction.id, 110n, 'rollback'), /rollback before commit/);
  await f.client.timeout(1000).emitWithAck('auction:join', { auctionId: auction.id });
  assert.equal(received.length, 1);
  const restored = await (await f.request(`/${auction.id}/bids`, { token: null })).json();
  assert.equal(restored.currentBid.id, accepted.id);
  assert.equal(restored.total, 1);
});

test('settlement and cancellation hints have committed public REST state and no private fields', async t => {
  const f = await fixture(t);
  const auction = await f.expiredAuction();
  await f.client.timeout(1000).emitWithAck('auction:join', { auctionId: auction.id });
  const notification = once(f.client, 'auction:settled');
  const service = new SettlementService(f.settlementRepository, f.gate, f.events);
  await service.settle(auction.id);
  const [event] = await notification;
  assert.equal(event.receiptUrl, `/auctions/${auction.id}/receipt`);
  const receipt = await f.request(`/${auction.id}/receipt`, { token: null });
  assert.equal(receipt.status, 200);
  assert.ok(!JSON.stringify(event).includes(f.users.bidder1));
  const empty = await f.createAuction();
  await f.client.timeout(1000).emitWithAck('auction:join', { auctionId: empty.id });
  const cancelled = once(f.client, 'auction:cancelled');
  const auctions = new AuctionService(new DrizzleAuctionRepository(f.db, tx => new DrizzleAuditAppender(tx), f.events));
  await auctions.cancel(empty.id, f.users.auctioneer);
  assert.equal((await cancelled)[0].reason, 'SELLER_REQUEST');
  await assert.rejects(auctions.cancel(empty.id, f.users.auctioneer), { status: 409 });
  const eventRow = (await f.pool.query("SELECT payload FROM audit_events WHERE auction_id=$1 AND event_type='AUCTION_CANCELLED'", [empty.id])).rows[0];
  assert.equal(eventRow.payload.reason, 'SELLER_REQUEST');
});
