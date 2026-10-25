import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { isolatedDatabase, seedConfig } from './database.js';
import { serve } from './http.js';
import { seed } from '../../src/shared/database/seed.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { createAuctionModule } from '../../src/modules/auctions/index.ts';
import { createApp } from '../../src/app.ts';
import { auctions, bids } from '../../src/modules/auctions/infrastructure/schema.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';

export async function auctionFixture() {
  const database = await isolatedDatabase();
  let http;
  try {
    await seed(database.db, seedConfig);
    const otherId = randomUUID();
    await database.pool.query("INSERT INTO users SELECT $1, 'other@auction.test', password_hash, 'Other', 'AUCTIONEER', now(), now() FROM users WHERE email = 'auctioneer@verzel.local'", [otherId]);
    const rows = await database.pool.query('SELECT id, email FROM users');
    const ownerId = rows.rows.find((user) => user.email === 'auctioneer@verzel.local').id;
    const bidderId = rows.rows.find((user) => user.email === 'bidder1@verzel.local').id;
    const snapshotId = randomUUID();
    await database.pool.query("INSERT INTO product_snapshots (id, external_id, source, title, attributes, captured_at) VALUES ($1, 'local-1', 'test', 'Local snapshot', '{\"brand\":\"Local\"}', now())", [snapshotId]);
    const config = { jwtSecret: 'auction-test-secret-with-more-than-32-bytes', jwtExpiresInSeconds: 900 };
    const auth = await createAuthModule(database.db, config);
    http = await serve(createApp(auth.router, undefined, createAuctionModule(database.db, auth.authenticate)));
    async function token(id) {
      return new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(id)
        .setIssuer('verzel-auction-house').setAudience('verzel-api').setIssuedAt().setExpirationTime('15m')
        .sign(new TextEncoder().encode(config.jwtSecret));
    }
    const tokens = { owner: await token(ownerId), other: await token(otherId), bidder: await token(bidderId) };
    async function clock() {
      const result = await database.pool.query('SELECT clock_timestamp() AS now');
      return new Date(result.rows[0].now);
    }
    async function payload(overrides = {}) {
      const now = await clock();
      return { productSnapshotId: snapshotId, startingBidCents: '1000', minIncrementCents: '100', startsAt: new Date(+now + 3600000).toISOString(), endsAt: new Date(+now + 7200000).toISOString(), ...overrides };
    }
    async function fixture(overrides = {}) {
      const now = await clock();
      const auction = { id: randomUUID(), auctioneerId: ownerId, productSnapshotId: snapshotId, currentBidId: null, startingBidCents: 1000n, minIncrementCents: 100n, startsAt: new Date(+now + 3600000), endsAt: new Date(+now + 7200000), status: 'PUBLISHED', createdAt: now, updatedAt: now, ...overrides };
      await database.db.transaction(async tx => {
        await tx.insert(auctions).values(auction);
        if (auction.status === 'PUBLISHED') await new DrizzleAuditAppender(tx).append({ auctionId: auction.id, eventType: 'AUCTION_CREATED', createdAt: auction.createdAt.toISOString(), payload: {
          productSnapshotId: auction.productSnapshotId, startingBidCents: String(auction.startingBidCents), minIncrementCents: String(auction.minIncrementCents),
          startsAt: auction.startsAt.toISOString(), endsAt: auction.endsAt.toISOString(), status: 'PUBLISHED', currentBidId: null,
        } });
      });
      return auction;
    }
    async function addBid(auctionId, executor = database.db) {
      await executor.insert(bids).values({ id: randomUUID(), auctionId, bidderId, amountCents: 2000n, sequence: 1n, createdAt: await clock() });
    }
    function request(path = '', { method = 'GET', token, body } = {}) {
      return fetch(`${http.url}/auctions${path}`, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    return { ...database, url: http.url, ownerId, otherId, bidderId, snapshotId, tokens, clock, payload, fixture, addBid, request,
      async reset() { await database.pool.query('DELETE FROM bid_operations; DELETE FROM wallet_reservations; DELETE FROM audit_anchors; DELETE FROM audit_events; UPDATE auctions SET current_bid_id = NULL; DELETE FROM bids; DELETE FROM auctions'); },
      async close() { await http.close(); await database.close(); },
    };
  } catch (error) {
    await http?.close();
    await database.close();
    throw error;
  }
}
