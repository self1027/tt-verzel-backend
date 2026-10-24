import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { attachAuctionSockets } from '../src/modules/realtime/auction-sockets.ts';

const auctionId = '1abcdef0-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';

async function setup(t) {
  const server = createServer();
  const realtime = attachAuctionSockets(server, ['https://example.com']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await realtime.close();
  });
  return { ...realtime, connect(origin, transport = 'websocket') {
    const client = io(url, { transports: [transport], reconnection: false, ...(origin ? { extraHeaders: { Origin: origin } } : {}) });
    clients.push(client);
    return client;
  } };
}

test('public room joins normalize UUIDs, isolate events, and leave stops updates', async t => {
  const sockets = await setup(t);
  const first = sockets.connect('https://example.com');
  const second = sockets.connect();
  await Promise.all([once(first, 'connect'), once(second, 'connect')]);
  assert.deepEqual(await first.emitWithAck('auction:join', { auctionId: auctionId.toUpperCase() }), { ok: true });
  assert.deepEqual(await second.emitWithAck('auction:join', { auctionId: otherId }), { ok: true });
  assert.deepEqual(await first.emitWithAck('auction:join', { auctionId: 'anything' }), { ok: false, error: 'INVALID_AUCTION' });
  const unexpected = [];
  second.on('bid:accepted', event => unexpected.push(event));
  const accepted = once(first, 'bid:accepted');
  sockets.events.publish({ type: 'bid:accepted', auctionId, data: { currentPrice: '120', bidId: 'public-bid' } });
  assert.deepEqual((await accepted)[0], { auctionId, currentPrice: '120', bidId: 'public-bid' });
  assert.deepEqual(await first.emitWithAck('auction:leave', { auctionId }), { ok: true });
  first.on('bid:accepted', event => unexpected.push(event));
  sockets.events.publish({ type: 'bid:accepted', auctionId, data: { currentPrice: '130' } });
  first.emit('bid:accepted', { auctionId: otherId, password: 'secret', token: 'secret' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(unexpected, []);
});

test('room subscriptions are bounded per connection', async t => {
  const sockets = await setup(t);
  const client = sockets.connect();
  await once(client, 'connect');
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(await client.emitWithAck('auction:join', { auctionId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` }), { ok: true });
  }
  assert.deepEqual(await client.emitWithAck('auction:join', { auctionId: otherId }), { ok: true });
  assert.deepEqual(await client.emitWithAck('auction:join', { auctionId: '20000000-0000-4000-8000-000000000001' }), { ok: false, error: 'ROOM_LIMIT' });
  assert.deepEqual(await client.emitWithAck('auction:leave', { auctionId: '10000000-0000-4000-8000-000000000001' }), { ok: true });
  assert.deepEqual(await client.emitWithAck('auction:join', { auctionId: '20000000-0000-4000-8000-000000000001' }), { ok: true });
});

test('unconfigured browser origins cannot connect using websocket or polling', async t => {
  const sockets = await setup(t);
  for (const transport of ['websocket', 'polling']) {
    const client = sockets.connect('https://evil.example', transport);
    const [error] = await once(client, 'connect_error');
    assert.ok(error);
    assert.equal(client.connected, false);
  }
});
