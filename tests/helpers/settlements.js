import { bidFixture } from './bids.js';
import { BidService } from '../../src/modules/bids/services/bid-service.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { DrizzleSettlementAuditGate } from '../../src/modules/settlements/infrastructure/settlement-proof.ts';
import { DrizzleSettlementRepository } from '../../src/modules/settlements/repositories/drizzle-settlement-repository.ts';
import { SettlementService } from '../../src/modules/settlements/services/settlement-service.ts';

export async function settlementFixture() {
  const f = await bidFixture();
  const heads = new Map();
  const external = { latest: async id => heads.get(id) ?? null };
  const gate = new DrizzleSettlementAuditGate(f.db, external);
  const settlementRepository = new DrizzleSettlementRepository(f.db);
  async function anchor(id) {
    const snapshot = await new DrizzleAuditRepository(f.db).snapshot(id);
    const event = snapshot.events.at(-1);
    const head = { namespace: 'controlled-test-witness', auctionId: id, sequence: String(event.sequence), hash: event.eventHash,
      previousSequence: '0', previousHash: '0'.repeat(64), reference: `fixture:${id}`, publishedAt: new Date().toISOString(), signature: 'controlled-provider' };
    heads.set(id, head);
    return head;
  }
  async function expiredAuction(withBid = true) {
    const auction = await f.createAuction({ endsAt: new Date(+(await f.clock()) - 1000) });
    if (withBid) {
      await f.deposit('bidder1');
      const clock = new Date(Date.parse(auction.endsAt) - 180000);
      const service = new BidService({ transaction: work => f.repository.transaction(tx => work({ ...tx, databaseNow: async () => clock })) }, f.service);
      await service.placeBid(f.users.bidder1, auction.id, 100n, 'historic-fixture-bid');
    }
    await anchor(auction.id);
    return auction;
  }
  return { ...f, heads, external, gate, settlementRepository, anchor, expiredAuction,
    settlementService: new SettlementService(settlementRepository, gate),
    async reset() { heads.clear(); await f.pool.query('DELETE FROM auction_settlements'); await f.reset(); },
  };
}
