import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { bidFixture } from '../helpers/bids.js';
import { serve } from '../helpers/http.js';
import { createWitnessServer } from '../../src/modules/audit/witness/server.ts';
import { HttpAnchorProvider } from '../../src/modules/audit/infrastructure/http-anchor-provider.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { AnchorWorker } from '../../src/modules/audit/services/anchor-worker.ts';
import { AuditVerifier } from '../../src/modules/audit/services/audit-verifier.ts';

test('a committed funded bid is externally verified only after the existing outbox publishes it', async () => {
  const f = await bidFixture();
  const directory = await mkdtemp(join(tmpdir(), 'bid-anchor-'));
  let witness, http;
  try {
    const keys = generateKeyPairSync('ed25519');
    witness = await createWitnessServer({ namespace: 'bid-test', journalPath: join(directory, 'journal'),
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publishToken: 'temporary-test-publish-token' });
    http = await serve(witness.app);
    const external = new HttpAnchorProvider({ baseUrl: http.url, namespace: 'bid-test',
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), publishToken: 'temporary-test-publish-token' });
    await f.deposit('bidder1');
    const auction = await f.createAuction({ endsAt: new Date(+(await f.clock()) + 90000) });
    const bid = await f.service.placeBid(f.users.bidder1, auction.id, 100n, 'anchor-bid');
    assert.equal(await external.latest(auction.id), null);
    const repository = new DrizzleAuditRepository(f.db);
    const verifier = new AuditVerifier(repository, external);
    assert.equal((await verifier.verify(auction.id)).status, 'PENDING_ANCHOR');
    assert.deepEqual(await new AnchorWorker(repository, external).runOnce(), { confirmed: 2, failed: 0, blocked: 0 });
    const verified = await verifier.verify(auction.id);
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(verified.externallyVerifiedSequence, '2');
    assert.equal(verified.operationalCoverage, 'CONSISTENT');
    const stored = await repository.snapshot(auction.id);
    assert.equal(stored.events[1].payload.bidId, bid.id);
    assert.equal(stored.events[1].payload.endsAt, bid.endsAt);
  } finally {
    await http?.close(); await witness?.close(); await f.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
