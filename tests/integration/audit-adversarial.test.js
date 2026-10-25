import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { auctionFixture } from '../helpers/auctions.js';
import { serve } from '../helpers/http.js';
import { createApp } from '../../src/app.ts';
import { createAuditModule } from '../../src/modules/audit/index.ts';
import { DrizzleAuditAppender } from '../../src/modules/audit/repositories/drizzle-audit-appender.ts';
import { DrizzleAuditRepository } from '../../src/modules/audit/repositories/drizzle-audit-repository.ts';
import { AuditVerifier } from '../../src/modules/audit/services/audit-verifier.ts';
import { AnchorWorker } from '../../src/modules/audit/services/anchor-worker.ts';
import { HttpAnchorProvider } from '../../src/modules/audit/infrastructure/http-anchor-provider.ts';
import { createWitnessServer } from '../../src/modules/audit/witness/server.ts';
import { bidderReference, checkChain, hashEvent } from '../../src/modules/audit/domain/cryptography.ts';
import { auctions, bids } from '../../src/modules/auctions/infrastructure/schema.ts';

let f, repository, provider, witness, witnessHttp, directory, options;
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });

function httpProvider(baseUrl) {
  return new HttpAnchorProvider({ baseUrl, namespace: options.namespace, publicKey,
    publishToken: options.publishToken, timeoutMs: 1000 });
}
async function startWitness() {
  witness = await createWitnessServer(options);
  witnessHttp = await serve(witness.app);
  provider = httpProvider(witnessHttp.url);
}
async function stopWitness() {
  await witnessHttp?.close(); witnessHttp = undefined;
  await witness?.close(); witness = undefined;
}
before(async () => {
  f = await auctionFixture();
  repository = new DrizzleAuditRepository(f.db);
  directory = await mkdtemp(join(tmpdir(), 'auction-adversarial-'));
  options = { namespace: 'adversarial-tests', journalPath: join(directory, 'witness.jsonl'),
    privateKey, publishToken: 'adversarial-publish-secret' };
  await startWitness();
});
beforeEach(async () => { await f.reset(); });
after(async () => {
  await stopWitness();
  await f?.close();
  if (directory) {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

async function createAuction(overrides) {
  const response = await f.request('', { method: 'POST', token: f.tokens.owner, body: await f.payload(overrides) });
  assert.equal(response.status, 201);
  return (await response.json()).auction;
}
async function edit(auctionId, amount) {
  const response = await f.request(`/${auctionId}`, { method: 'PATCH', token: f.tokens.owner, body: { startingBidCents: amount } });
  assert.equal(response.status, 200);
}
async function anchor(auctionId) {
  const result = await new AnchorWorker(repository, provider).runOnce();
  assert.equal(result.failed, 0);
  assert.equal((await verify(auctionId)).status, 'VERIFIED');
}
function verify(auctionId, external = provider) { return new AuditVerifier(repository, external).verify(auctionId); }
async function tampered(auctionId) {
  const result = await verify(auctionId);
  assert.equal(result.status, 'TAMPERED');
  return result;
}
async function liveBidFixture() {
  const now = await f.clock();
  const auction = await createAuction({ startsAt: new Date(+now + 1000).toISOString() });
  await f.pool.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.01)', [auction.startsAt]);
  const createdAt = await f.clock();
  const bid = { id: randomUUID(), auctionId: auction.id, bidderId: f.bidderId,
    amountCents: 2000n, sequence: 1n, createdAt };
  await f.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM auctions WHERE id=${auction.id} FOR UPDATE`);
    await tx.insert(bids).values(bid);
    await tx.update(auctions).set({ currentBidId: bid.id }).where(sql`${auctions.id}=${auction.id}`);
    await new DrizzleAuditAppender(tx).append({ auctionId: auction.id, eventType: 'BID_ACCEPTED',
      createdAt: createdAt.toISOString(), payload: { bidId: bid.id, bidderRef: bidderReference(auction.id, f.bidderId),
        amountCents: '2000', bidSequence: '1', createdAt: createdAt.toISOString(), endsAt: auction.endsAt } });
  });
  await anchor(auction.id);
  return { auction, bid };
}

test('anchored event modification is detected and injected PII is withheld from public pages', async (t) => {
  const auction = await createAuction();
  await anchor(auction.id);
  const secret = 'private-attacker@example.test';
  await f.pool.query("UPDATE audit_events SET payload=jsonb_set(payload::jsonb,'{email}',to_jsonb($1::text)) WHERE auction_id=$2", [secret, auction.id]);
  await tampered(auction.id);
  const audit = createAuditModule(f.db, provider);
  const http = await serve(createApp(Router(), undefined, undefined, undefined, audit.router));
  t.after(() => http.close());
  const response = await fetch(`${http.url}/auctions/${auction.id}/audit/events`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(secret), false);
  assert.deepEqual(JSON.parse(text).events, []);
  assert.equal(JSON.parse(text).status, 'TAMPERED');
});

test('a fake SQL event insertion cannot inherit trust from the anchored prefix', async () => {
  const auction = await createAuction();
  await anchor(auction.id);
  await f.pool.query('INSERT INTO audit_events (id,auction_id,sequence,event_type,payload,previous_hash,event_hash,created_at,hash_version) SELECT gen_random_uuid(),auction_id,2,event_type,payload,event_hash,event_hash,created_at,hash_version FROM audit_events WHERE auction_id=$1', [auction.id]);
  await tampered(auction.id);
});

test('public pages withhold attacker-injected PII in hash envelope fields', async (t) => {
  const auction = await createAuction();
  await anchor(auction.id);
  const secret = 'private-envelope@example.test';
  await f.pool.query('UPDATE audit_events SET previous_hash=$1,event_hash=$1 WHERE auction_id=$2', [secret, auction.id]);
  await tampered(auction.id);
  const audit = createAuditModule(f.db, provider);
  const http = await serve(createApp(Router(), undefined, undefined, undefined, audit.router));
  t.after(() => http.close());
  const response = await fetch(`${http.url}/auctions/${auction.id}/audit/events`);
  const text = await response.text();
  assert.equal(text.includes(secret), false);
  assert.deepEqual(JSON.parse(text).events, []);
  assert.equal(JSON.parse(text).status, 'TAMPERED');
});

test('intermediate deletion exposes a sequence gap', async () => {
  const auction = await createAuction();
  await edit(auction.id, '2000'); await edit(auction.id, '3000'); await anchor(auction.id);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1 AND sequence=2', [auction.id]);
  await tampered(auction.id);
});

test('deleting the final event and every local anchor still conflicts with independent latest', async () => {
  const auction = await createAuction();
  await edit(auction.id, '2000'); await anchor(auction.id);
  const head = await provider.latest(auction.id);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1 AND sequence=2', [auction.id]);
  await f.pool.query('UPDATE auctions SET starting_bid_cents=1000 WHERE id=$1', [auction.id]);
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1', [auction.id]);
  const result = await tampered(auction.id);
  assert.equal(result.reason, 'EXTERNAL_ANCHOR_MISMATCH');
  assert.equal(result.externalHeadSequence, '2');
  assert.deepEqual(await provider.latest(auction.id), head);
});

test('deleting all audit rows and the auction cannot hide a previously published auction', async () => {
  const auction = await createAuction();
  await anchor(auction.id);
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1', [auction.id]);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1', [auction.id]);
  await f.pool.query('DELETE FROM auctions WHERE id=$1', [auction.id]);
  const result = await tampered(auction.id);
  assert.equal(result.reason, 'ANCHORED_AUCTION_MISSING');
});

test('a fully valid rewritten chain and matching operational state disagree with the signed external hash', async () => {
  const auction = await createAuction();
  await edit(auction.id, '2000'); await anchor(auction.id);
  const snapshot = await repository.snapshot(auction.id);
  let previousHash = '0'.repeat(64);
  const rewritten = [];
  for (const event of snapshot.events) {
    const unsigned = { ...event };
    delete unsigned.eventHash;
    unsigned.payload = { ...unsigned.payload, startingBidCents: '9000' };
    unsigned.previousHash = previousHash;
    const replacement = { ...unsigned, eventHash: hashEvent(unsigned) };
    rewritten.push(replacement); previousHash = replacement.eventHash;
    await f.pool.query('UPDATE audit_events SET payload=$1,previous_hash=$2,event_hash=$3 WHERE id=$4', [JSON.stringify(replacement.payload), replacement.previousHash, replacement.eventHash, replacement.id]);
  }
  assert.equal(checkChain(auction.id, rewritten).valid, true);
  await f.pool.query('UPDATE auctions SET starting_bid_cents=9000 WHERE id=$1', [auction.id]);
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1', [auction.id]);
  const result = await tampered(auction.id);
  assert.equal(result.operationalCoverage, 'CONSISTENT');
  assert.equal(result.reason, 'EXTERNAL_ANCHOR_MISMATCH');
});

test('anchored bid amount changes are detected against the public bid commitment', async () => {
  const { auction, bid } = await liveBidFixture();
  await f.pool.query('UPDATE bids SET amount_cents=9000 WHERE id=$1', [bid.id]);
  const result = await tampered(auction.id);
  assert.equal(result.operationalCoverage, 'DIVERGENT');
});

test('current bid pointer changes are detected even if the bid history remains intact', async () => {
  const { auction } = await liveBidFixture();
  await f.pool.query('UPDATE auctions SET current_bid_id=NULL WHERE id=$1', [auction.id]);
  await tampered(auction.id);
});

test('an operational bid inserted without an audit commitment cannot pass verification', async () => {
  const auction = await createAuction();
  await anchor(auction.id);
  await f.addBid(auction.id);
  await tampered(auction.id);
});

test('forged SQL confirmations cannot manufacture external proof', async () => {
  const auction = await createAuction();
  await f.pool.query("UPDATE audit_anchors SET external_reference='forged:success',anchored_at=now() WHERE auction_id=$1", [auction.id]);
  assert.deepEqual(await repository.pending(10), []);
  assert.equal(await provider.latest(auction.id), null);
  const result = await verify(auction.id);
  assert.equal(result.status, 'PENDING_ANCHOR');
  assert.equal(result.externallyVerifiedSequence, '0');
});

test('external outage after a committed auction preserves outbox state and a restarted worker recovers', async () => {
  const auction = await createAuction();
  const unavailable = provider;
  await stopWitness();
  try {
    assert.deepEqual(await new AnchorWorker(repository, unavailable).runOnce(), { confirmed: 0, failed: 1, blocked: 0 });
    assert.equal((await repository.pending(10)).length, 1);
    assert.equal((await verify(auction.id, unavailable)).status, 'VERIFICATION_UNAVAILABLE');
    assert.equal((await repository.snapshot(auction.id)).events.length, 1);
  } finally { await startWitness(); }
  assert.deepEqual(await new AnchorWorker(repository, provider).runOnce(), { confirmed: 1, failed: 0, blocked: 0 });
  assert.deepEqual(await repository.pending(10), []);
  assert.equal((await verify(auction.id)).status, 'VERIFIED');
});

test('lost publication response retries reconcile one durable receipt after worker and witness restart', async (t) => {
  const auction = await createAuction();
  let dropped = false;
  const upstream = witnessHttp.url;
  const proxy = await serve(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const remote = await fetch(`${upstream}${request.url}`, { method: request.method,
        headers: { 'content-type': 'application/json', authorization: request.headers.authorization ?? '' },
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const body = await remote.text();
      if (request.method === 'POST' && !dropped && remote.ok) { dropped = true; response.destroy(); return; }
      response.writeHead(remote.status, { 'content-type': 'application/json' }); response.end(body);
    } catch { response.destroy(); }
  });
  t.after(() => proxy.close());
  assert.deepEqual(await new AnchorWorker(repository, httpProvider(proxy.url)).runOnce(), { confirmed: 0, failed: 1, blocked: 0 });
  assert.equal(dropped, true);
  const head = await provider.latest(auction.id);
  assert.equal(head.sequence, '1');
  assert.equal((await repository.pending(10)).length, 1);
  await stopWitness(); await startWitness();
  assert.deepEqual(await provider.latest(auction.id), head);
  assert.deepEqual(await new AnchorWorker(repository, provider).runOnce(), { confirmed: 1, failed: 0, blocked: 0 });
  assert.equal((await verify(auction.id)).status, 'VERIFIED');
  const entries = (await readFile(options.journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter((entry) => entry.auctionId === auction.id).length, 1);
});

test('a valid unanchored rewrite is pending rather than verified because SQL can rewrite that suffix', async () => {
  const auction = await createAuction();
  const [event] = (await repository.snapshot(auction.id)).events;
  const unsigned = { ...event };
  delete unsigned.eventHash;
  unsigned.payload = { ...unsigned.payload, startingBidCents: '7000' };
  await f.pool.query('UPDATE audit_events SET payload=$1,event_hash=$2 WHERE id=$3', [JSON.stringify(unsigned.payload), hashEvent(unsigned), event.id]);
  await f.pool.query('UPDATE auctions SET starting_bid_cents=7000 WHERE id=$1', [auction.id]);
  const result = await verify(auction.id);
  assert.equal(result.status, 'PENDING_ANCHOR');
  assert.equal(result.operationalCoverage, 'CONSISTENT');
  assert.equal(result.externallyVerifiedSequence, '0');
});

test('rollback of an entirely unanchored suffix cannot prove that discarded suffix ever existed', async () => {
  const auction = await createAuction();
  await anchor(auction.id);
  await edit(auction.id, '7000');
  assert.equal((await verify(auction.id)).status, 'PENDING_ANCHOR');
  await f.pool.query('DELETE FROM audit_anchors WHERE auction_id=$1 AND last_sequence=2', [auction.id]);
  await f.pool.query('DELETE FROM audit_events WHERE auction_id=$1 AND sequence=2', [auction.id]);
  await f.pool.query('UPDATE auctions SET starting_bid_cents=$1 WHERE id=$2', [auction.startingBidCents, auction.id]);
  const result = await verify(auction.id);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.localSequence, '1');
  assert.equal(result.externallyVerifiedSequence, '1');
});
