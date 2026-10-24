import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { SettlementWorker } from '../src/modules/settlements/workers/settlement-worker.ts';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('worker handles independent auction errors and backs off deferred or failed work', async () => {
  let now = 0;
  const calls = [];
  const repository = { async due(limit) { assert.equal(limit, 5); return ['bad', 'pending', 'healthy']; } };
  const service = { async settle(id) {
    calls.push(id);
    if (id === 'bad') throw new Error('database unavailable');
    return { auctionId: id, status: id === 'pending' ? 'DEFERRED' : 'SETTLED' };
  } };
  const worker = new SettlementWorker(repository, service, { now: () => now, baseDelayMs: 100, maxDelayMs: 400, batchSize: 5, log() {} });
  await worker.runOnce();
  assert.deepEqual(calls, ['bad', 'pending', 'healthy']);
  calls.length = 0;
  now = 99;
  await worker.runOnce();
  assert.deepEqual(calls, ['healthy']);
  calls.length = 0;
  now = 100;
  await worker.runOnce();
  assert.deepEqual(calls, ['bad', 'pending', 'healthy']);
  calls.length = 0;
  now = 299;
  await worker.runOnce();
  assert.deepEqual(calls, ['healthy']);
  calls.length = 0;
  now = 300;
  await worker.runOnce();
  assert.deepEqual(calls, ['bad', 'pending', 'healthy']);
  calls.length = 0;
  now = 700;
  await worker.runOnce();
  assert.deepEqual(calls, ['bad', 'pending', 'healthy']);
  calls.length = 0;
  now = 1100;
  await worker.runOnce();
  assert.deepEqual(calls, ['bad', 'pending', 'healthy']);
  await worker.stop();
});

test('worker does not overlap a local run and stop drains its active transaction', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0, scanned = 0;
  const worker = new SettlementWorker({ async due() { scanned++; return ['auction']; } }, {
    async settle() { calls++; entered.resolve(); await release.promise; return { auctionId: 'auction', status: 'SETTLED' }; },
  });
  const first = worker.runOnce();
  await entered.promise;
  const second = worker.runOnce();
  let drained = false;
  const stopped = worker.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(calls, 1);
  assert.equal(scanned, 1);
  release.resolve();
  await Promise.all([first, second, stopped]);
  assert.equal(drained, true);
});

test('worker restart retries persisted due auctions without retaining process backoff', async () => {
  let calls = 0;
  const repository = { async due() { return ['auction']; } };
  const service = { async settle() { calls++; return { auctionId: 'auction', status: 'DEFERRED' }; } };
  const options = { now: () => 0, baseDelayMs: 100 };
  const first = new SettlementWorker(repository, service, options);
  await first.runOnce();
  await first.runOnce();
  assert.equal(calls, 1);
  await first.stop();
  const restarted = new SettlementWorker(repository, service, options);
  await restarted.runOnce();
  assert.equal(calls, 2);
  await restarted.stop();
});

test('successful work resets the auction retry delay after a previous failure', async () => {
  let now = 0, calls = 0;
  const worker = new SettlementWorker({ async due() { return ['auction']; } }, {
    async settle() {
      calls++;
      return { auctionId: 'auction', status: calls === 2 ? 'SETTLED' : 'DEFERRED' };
    },
  }, { now: () => now, baseDelayMs: 100, maxDelayMs: 800 });
  await worker.runOnce();
  now = 100;
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(calls, 3);
  now = 199;
  await worker.runOnce();
  assert.equal(calls, 3);
  now = 200;
  await worker.runOnce();
  assert.equal(calls, 4);
  await worker.stop();
});

test('start polls and stop removes the timer', async () => {
  const called = deferred();
  let scans = 0;
  const worker = new SettlementWorker({ async due() { scans++; if (scans === 2) called.resolve(); return []; } }, { async settle() { assert.fail('empty queue'); } });
  assert.throws(() => worker.start(5), /at least 100ms/);
  worker.start(100);
  try {
    await Promise.race([called.promise, setTimeout(500).then(() => { throw new Error('worker never polled'); })]);
  } finally { await worker.stop(); }
  const stoppedAt = scans;
  await setTimeout(110);
  assert.equal(scans, stoppedAt);
});

test('backoff excludes failing auctions from discovery so later lots can progress', async () => {
  let now = 0;
  const calls = [], discovered = [];
  const worker = new SettlementWorker({ async due(limit, excluded = []) {
    discovered.push([...excluded]);
    return ['tampered', 'healthy'].filter(id => !excluded.includes(id)).slice(0, limit);
  } }, { async settle(id) {
    calls.push(id);
    return { auctionId: id, status: id === 'tampered' ? 'TAMPERED' : 'SETTLED' };
  } }, { now: () => now, baseDelayMs: 100, batchSize: 1 });
  await worker.runOnce();
  now = 1;
  await worker.runOnce();
  assert.deepEqual(calls, ['tampered', 'healthy']);
  assert.deepEqual(discovered, [[], ['tampered']]);
  await worker.stop();
});
