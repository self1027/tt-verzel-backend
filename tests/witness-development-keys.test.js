import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';

test('development bootstrap generates Ed25519 keys once and restores the matching public key', async () => {
  const { prepareDevelopmentKeys } = await import('../docker/witness/start.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'witness-dev-keys-'));
  try {
    const privatePath = join(directory, 'private', 'key.pem');
    const publicPath = join(directory, 'public', 'key.pem');
    await prepareDevelopmentKeys(privatePath, publicPath);
    const privatePem = await readFile(privatePath, 'utf8');
    assert.equal(createPrivateKey(privatePem).asymmetricKeyType, 'ed25519');
    const publicPem = await readFile(publicPath, 'utf8');
    assert.equal(createPublicKey(privatePem).export({ type: 'spki', format: 'pem' }), publicPem);
    await rm(publicPath);
    await prepareDevelopmentKeys(privatePath, publicPath);
    assert.equal(await readFile(privatePath, 'utf8'), privatePem);
    assert.equal(await readFile(publicPath, 'utf8'), publicPem);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
