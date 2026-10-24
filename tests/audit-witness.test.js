import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, appendFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const checkpoint = (sequence = '1', hash = 'a'.repeat(64)) => ({ auctionId: 'auction-1', sequence, hash });
async function modules() {
  const provider = await import('../src/modules/audit/infrastructure/http-anchor-provider.ts');
  const witness = await import('../src/modules/audit/witness/server.ts');
  return { ...provider, ...witness };
}
async function fixture(t) {
  const { createWitnessServer, HttpAnchorProvider } = await modules();
  const directory = await mkdtemp(join(tmpdir(), 'auction-witness-'));
  const options = { namespace: 'test-auctions', journalPath: join(directory, 'journal.jsonl'), privateKey, publishToken: 'secret-publisher-token' };
  let witness;
  let server;
  let baseUrl;
  async function start() {
    witness = await createWitnessServer(options);
    server = witness.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return new HttpAnchorProvider({ baseUrl, namespace: options.namespace, publicKey, publishToken: options.publishToken });
  }
  async function stop() {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await witness.close();
  }
  const provider = await start();
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return { provider, options, start, stop, createWitnessServer, get baseUrl() { return baseUrl; } };
}

test('external latest remains independently available and receipt retries survive journal restart', async (t) => {
  const fixtureState = await fixture(t);
  const { provider } = fixtureState;
  assert.equal(await provider.latest('auction-1'), null);
  const first = await provider.publish(checkpoint(), null);
  assert.equal(first.namespace, 'test-auctions');
  assert.equal(first.previousSequence, '0');
  assert.equal(first.previousHash, '0'.repeat(64));
  assert.match(first.reference, /^sha256:[a-f0-9]{64}$/);
  const second = await provider.publish(checkpoint('2', 'b'.repeat(64)), first);
  assert.deepEqual(await provider.publish(checkpoint(), null), first);
  assert.deepEqual(await provider.latest('auction-1'), second);
  await fixtureState.stop();
  const restarted = await fixtureState.start();
  assert.deepEqual(await restarted.latest('auction-1'), second);
  assert.deepEqual(await restarted.publish(checkpoint(), null), first);
  const journal = await readFile(fixtureState.options.journalPath, 'utf8');
  assert.equal(journal.trim().split('\n').length, 2);
});

test('CAS conflicts and competing writers cannot overwrite a published checkpoint', async (t) => {
  const { provider } = await fixture(t);
  const first = await provider.publish(checkpoint(), null);
  await assert.rejects(provider.publish(checkpoint('1', 'f'.repeat(64)), null), /409|conflict/i);
  await assert.rejects(provider.publish(checkpoint('2'), null), /409|conflict/i);
  const outcomes = await Promise.allSettled([
    provider.publish(checkpoint('2', 'b'.repeat(64)), first),
    provider.publish(checkpoint('2', 'c'.repeat(64)), first),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const winning = outcomes.find((result) => result.status === 'fulfilled').value;
  assert.deepEqual(await provider.latest('auction-1'), winning);
  await assert.rejects(provider.publish(checkpoint('1'), winning), /previous|409|conflict/i);
});

test('bearer authorization protects append while latest is public and namespace is checked', async (t) => {
  const state = await fixture(t);
  const { HttpAnchorProvider } = await modules();
  const anonymous = new HttpAnchorProvider({ baseUrl: state.baseUrl, namespace: 'test-auctions', publicKey });
  assert.equal(await anonymous.latest('auction-1'), null);
  await assert.rejects(anonymous.publish(checkpoint(), null), /401|token|credential/i);
  await state.provider.publish(checkpoint(), null);
  assert.equal((await anonymous.latest('auction-1')).sequence, '1');
  const wrong = new HttpAnchorProvider({ baseUrl: state.baseUrl, namespace: 'wrong', publicKey, publishToken: 'secret-publisher-token' });
  await assert.rejects(wrong.latest('auction-1'), /namespace|400|409/i);
  const response = await fetch(`${state.baseUrl}/v1/namespaces/test-auctions/auctions/auction-1/checkpoints`, { method: 'DELETE' });
  assert.equal(response.status, 404);
});

test('pinned Ed25519 key rejects forged signatures, wrong namespace and malformed heads', async (t) => {
  const state = await fixture(t);
  const receipt = await state.provider.publish(checkpoint(), null);
  const { HttpAnchorProvider } = await modules();
  let response = receipt;
  const server = createServer((_request, result) => { result.setHeader('content-type', 'application/json'); result.end(JSON.stringify(response)); });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const provider = new HttpAnchorProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, namespace: 'test-auctions', publicKey });
  assert.deepEqual(await provider.latest('auction-1'), receipt);
  for (const change of [
    { hash: 'f'.repeat(64) }, { signature: Buffer.alloc(64).toString('base64') },
    { namespace: 'other' }, { auctionId: 'other' }, { sequence: '01' }, { sequence: '0' },
    { reference: 'anything' }, { previousSequence: '-1' },
  ]) {
    response = { ...receipt, ...change };
    await assert.rejects(provider.latest('auction-1'));
  }
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const wrongKey = new HttpAnchorProvider({ baseUrl: `http://127.0.0.1:${server.address().port}`, namespace: 'test-auctions', publicKey: otherKey });
  response = receipt;
  await assert.rejects(wrongKey.latest('auction-1'), /signature/i);
});

test('network failures and timeouts fail closed, and lost publication responses are retryable', async (t) => {
  const state = await fixture(t);
  const { HttpAnchorProvider } = await modules();
  let drop = true;
  const proxy = createServer(async (request, response) => {
    if (request.url === '/slow') return;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const remote = await fetch(`${state.baseUrl}${request.url}`, {
      method: request.method, headers: { 'content-type': 'application/json', authorization: request.headers.authorization ?? '' },
      ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = await remote.text();
    if (drop) { drop = false; response.destroy(); return; }
    response.writeHead(remote.status, { 'content-type': 'application/json' }); response.end(body);
  });
  proxy.listen(0, '127.0.0.1');
  await new Promise((resolve) => proxy.once('listening', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const baseUrl = `http://127.0.0.1:${proxy.address().port}`;
  const provider = new HttpAnchorProvider({ baseUrl, namespace: 'test-auctions', publicKey, publishToken: 'secret-publisher-token', timeoutMs: 1000 });
  await assert.rejects(provider.publish(checkpoint(), null));
  const retry = await provider.publish(checkpoint(), null);
  assert.deepEqual(retry, await state.provider.latest('auction-1'));
  const hanging = createServer(() => {});
  hanging.listen(0, '127.0.0.1');
  await new Promise((resolve) => hanging.once('listening', resolve));
  t.after(() => { hanging.closeAllConnections(); hanging.close(); });
  const timeout = new HttpAnchorProvider({ baseUrl: `http://127.0.0.1:${hanging.address().port}`, namespace: 'test-auctions', publicKey, timeoutMs: 20 });
  await assert.rejects(timeout.latest('auction-1'), /timeout|abort/i);
});

test('journal exclusive ownership and corruption fail closed during startup', async (t) => {
  const state = await fixture(t);
  await state.provider.publish(checkpoint(), null);
  await assert.rejects(state.createWitnessServer(state.options), /lock|writer/i);
  await state.stop();
  await appendFile(state.options.journalPath, '{"truncated":');
  await assert.rejects(state.createWitnessServer(state.options), /journal|truncat/i);
  // Restore a valid journal so the fixture can perform its normal final shutdown.
  await writeFile(state.options.journalPath, '');
  await state.start();
});

test('provider requires authenticated TLS outside the explicit loopback development boundary', async () => {
  const { HttpAnchorProvider } = await modules();
  assert.throws(() => new HttpAnchorProvider({ baseUrl: 'http://witness.example', namespace: 'test-auctions', publicKey }), /HTTPS|TLS/i);
  assert.doesNotThrow(() => new HttpAnchorProvider({ baseUrl: 'https://witness.example', namespace: 'test-auctions', publicKey }));
  assert.doesNotThrow(() => new HttpAnchorProvider({ baseUrl: 'http://audit-witness:8081', namespace: 'test-auctions', publicKey,
    allowInsecureHttpForDevelopment: true }));
});

test('journal replay rejects changed signed records, duplicate sequences and reversed CAS history', async (t) => {
  const state = await fixture(t);
  const first = await state.provider.publish(checkpoint(), null);
  await state.provider.publish(checkpoint('2', 'b'.repeat(64)), first);
  await state.stop();
  const original = await readFile(state.options.journalPath, 'utf8');
  const lines = original.trim().split('\n');
  const changed = { ...JSON.parse(lines[0]), hash: 'c'.repeat(64) };
  for (const corrupted of [JSON.stringify(changed) + '\n', original + lines[0] + '\n', lines.reverse().join('\n') + '\n']) {
    await writeFile(state.options.journalPath, corrupted);
    await assert.rejects(state.createWitnessServer(state.options), /journal/i);
  }
  await writeFile(state.options.journalPath, original);
  const restarted = await state.start();
  assert.equal((await restarted.latest('auction-1')).sequence, '2');
});

test('hardlink aliases cannot produce two signed checkpoint writers, including aliases added after open', async (t) => {
  const { link, unlink } = await import('node:fs/promises');
  const state = await fixture(t);
  const alias = `${state.options.journalPath}.alias`;
  await link(state.options.journalPath, alias);
  await assert.rejects(state.createWitnessServer({ ...state.options, journalPath: alias }), /journal|link/i);
  await assert.rejects(state.provider.publish(checkpoint(), null), /503|journal/i);
  assert.equal(await readFile(state.options.journalPath, 'utf8'), '');
  await unlink(alias);
});

test('directory junction aliases share the same exclusive journal writer lock', async (t) => {
  const { symlink, unlink } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const state = await fixture(t);
  const directory = dirname(state.options.journalPath);
  const alias = `${directory}-alias`;
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(state.createWitnessServer({ ...state.options, journalPath: join(alias, 'journal.jsonl') }), /lock|writer/i);
  } finally { await unlink(alias); }
});

test('hardlinked writer locks fail closed before signing a checkpoint', async (t) => {
  const { link, unlink } = await import('node:fs/promises');
  const state = await fixture(t);
  const alias = `${state.options.journalPath}.lock-alias`;
  await link(`${state.options.journalPath}.lock`, alias);
  await assert.rejects(state.provider.publish(checkpoint(), null), /503|journal/i);
  assert.equal(await readFile(state.options.journalPath, 'utf8'), '');
  await unlink(alias);
});

test('leaf symlinks for journals and preexisting writer locks are rejected without deleting their targets', async (t) => {
  const { symlink, unlink, lstat } = await import('node:fs/promises');
  const state = await fixture(t);
  const alias = `${state.options.journalPath}.symlink`;
  try { await symlink(state.options.journalPath, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows account cannot create file symlinks'); return; }
    throw error;
  }
  try {
    await assert.rejects(state.createWitnessServer({ ...state.options, journalPath: alias }), /journal/i);
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(await readFile(state.options.journalPath, 'utf8'), '');
  } finally { await unlink(alias); }
  const otherPath = `${state.options.journalPath}.other`;
  const lockAlias = `${otherPath}.lock`;
  await symlink(`${state.options.journalPath}.lock`, lockAlias, 'file');
  try {
    await assert.rejects(state.createWitnessServer({ ...state.options, journalPath: otherPath }), /writer|lock/i);
    assert.equal((await lstat(lockAlias)).isSymbolicLink(), true);
    assert.equal((await lstat(`${state.options.journalPath}.lock`)).isFile(), true);
  } finally { await unlink(lockAlias); }
});
