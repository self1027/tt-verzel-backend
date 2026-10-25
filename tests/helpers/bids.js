import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { isolatedDatabase, seedConfig } from './database.js';
import { serve } from './http.js';
import { seed } from '../../src/shared/database/seed.ts';
import { createAuthModule } from '../../src/modules/auth/index.ts';
import { createAuctionModule } from '../../src/modules/auctions/index.ts';
import { createWalletModule } from '../../src/modules/wallets/index.ts';
import { createAuditModule } from '../../src/modules/audit/index.ts';
import { createApp } from '../../src/app.ts';
import { auctions } from '../../src/modules/auctions/infrastructure/schema.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';
import { DrizzleBidRepository } from '../../src/modules/bids/repositories/drizzle-bid-repository.ts';
import { DrizzleBidQueryRepository } from '../../src/modules/bids/repositories/drizzle-bid-query-repository.ts';
import { DrizzleReservationOperations } from '../../src/modules/wallets/repositories/drizzle-reservation-operations.ts';
import { BidService } from '../../src/modules/bids/services/bid-service.ts';

export async function bidFixture() {
  const database = await isolatedDatabase();
  let http;
  try {
    await seed(database.db, seedConfig);
    const rows = (await database.pool.query('SELECT id,email FROM users')).rows;
    const users = Object.fromEntries(['bidder1', 'bidder2', 'auctioneer'].map(name => [name, rows.find(row => row.email === `${name}@verzel.local`).id]));
    const config = { jwtSecret: 'bid-integration-secret-at-least-thirty-two-bytes', jwtExpiresInSeconds: 900 };
    const auth = await createAuthModule(database.db, config);
    http = await serve(createApp(auth.router, undefined, createAuctionModule(database.db, auth.authenticate),
      createWalletModule(database.db, auth.authenticate), createAuditModule(database.db).router));
    const tokens = {};
    for (const [name, id] of Object.entries(users)) tokens[name] = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(id).setIssuer('verzel-auction-house').setAudience('verzel-api').setIssuedAt().setExpirationTime('15m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    const snapshotId = randomUUID();
    await database.pool.query("INSERT INTO product_snapshots(id,external_id,source,title,captured_at) VALUES($1,'bid-fixture','test','Bid item',now())", [snapshotId]);
    async function clock() { return new Date((await database.pool.query('SELECT clock_timestamp() AS now')).rows[0].now); }
    async function createAuction(overrides = {}) {
      const now = await clock();
      const value = { id: randomUUID(), auctioneerId: users.auctioneer, productSnapshotId: snapshotId, currentBidId: null,
        startingBidCents: 100n, minIncrementCents: 10n, startsAt: new Date(+now - 3600000), endsAt: new Date(+now + 3600000),
        status: 'PUBLISHED', createdAt: new Date(+now - 7200000), updatedAt: new Date(+now - 7200000), ...overrides };
      value.startsAt = new Date(value.startsAt); value.endsAt = new Date(value.endsAt);
      value.startingBidCents = BigInt(value.startingBidCents); value.minIncrementCents = BigInt(value.minIncrementCents);
      await database.db.transaction(async tx => {
        await tx.insert(auctions).values(value);
        await new DrizzleAuditAppender(tx).append({ auctionId: value.id, eventType: 'AUCTION_CREATED', createdAt: value.createdAt.toISOString(), payload: {
          productSnapshotId: snapshotId, startingBidCents: String(value.startingBidCents), minIncrementCents: String(value.minIncrementCents),
          startsAt: value.startsAt.toISOString(), endsAt: value.endsAt.toISOString(), status: 'PUBLISHED', currentBidId: null,
        } });
      });
      return { ...value, startingBidCents: String(value.startingBidCents), minIncrementCents: String(value.minIncrementCents),
        startsAt: value.startsAt.toISOString(), endsAt: value.endsAt.toISOString() };
    }
    function request(path, { method = 'GET', token = tokens.bidder1, body, key } = {}) {
      return fetch(`${http.url}/auctions${path}`, { method, headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function deposit(name, amountCents = '100000') {
      const response = await fetch(`${http.url}/wallet/deposits`, { method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Bearer ${tokens[name]}`, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ amountCents }) });
      if (response.status !== 201) throw new Error(`Fixture deposit failed: ${response.status}`);
      return response.json();
    }
    const repository = new DrizzleBidRepository(database.db, new DrizzleReservationOperations(), tx => new DrizzleAuditAppender(tx));
    return { ...database, url: http.url, users, tokens, createAuction, request, deposit, clock, repository,
      service: new BidService(repository, new DrizzleBidQueryRepository(database.db)),
      async reset() {
        await database.pool.query('DELETE FROM auction_recoveries; DELETE FROM bid_operations; DELETE FROM wallet_reservations; DELETE FROM audit_anchors; DELETE FROM audit_events; UPDATE auctions SET current_bid_id=NULL; DELETE FROM bids; DELETE FROM auctions; DELETE FROM ledger_entries; DELETE FROM ledger_transactions; UPDATE wallets SET balance_cents=0,reserved_cents=0');
      },
      async close() { await http.close(); await database.close(); },
    };
  } catch (error) { await http?.close(); await database.close(); throw error; }
}
