import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';

test('partial unique index prevents two ACTIVE leaders while retaining released reservation history', async () => {
  const f = await bidFixture();
  try {
    await f.deposit('bidder1'); await f.deposit('bidder2');
    const auction = await f.createAuction();
    await f.service.placeBid(f.users.bidder1, auction.id, 100n, 'first');
    const wallet = (await f.pool.query('SELECT id FROM wallets WHERE user_id=$1', [f.users.bidder2])).rows[0].id;
    const id = randomUUID();
    await f.pool.query('INSERT INTO bids(id,auction_id,bidder_id,amount_cents,sequence,created_at) VALUES($1,$2,$3,110,2,now())', [id, auction.id, f.users.bidder2]);
    await assert.rejects(f.pool.query("INSERT INTO wallet_reservations(id,wallet_id,auction_id,bid_id,amount_cents,status,created_at) VALUES($1,$2,$3,$4,110,'ACTIVE',now())", [randomUUID(), wallet, auction.id, id]), { code: '23505' });
    await f.pool.query("INSERT INTO wallet_reservations(id,wallet_id,auction_id,bid_id,amount_cents,status,created_at,released_at) VALUES($1,$2,$3,$4,110,'RELEASED',now(),now())", [randomUUID(), wallet, auction.id, id]);
    assert.deepEqual((await f.pool.query('SELECT status,count(*)::text AS count FROM wallet_reservations GROUP BY status ORDER BY status')).rows,
      [{ status: 'ACTIVE', count: '1' }, { status: 'RELEASED', count: '1' }]);
  } finally { await f.close(); }
});
