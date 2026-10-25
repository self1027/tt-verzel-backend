import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertIsolatedDemoEnvironment } from '../scripts/demo-recovery.mjs';

test('optional recovery demo refuses production, shared database names, remote hosts and fallback DATABASE_URL', () => {
  const valid = { NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://user:secret@127.0.0.1/verzel_auction_test' };
  assert.doesNotThrow(() => assertIsolatedDemoEnvironment(valid));
  for (const env of [
    { ...valid, NODE_ENV: 'production' }, { NODE_ENV: 'test', DATABASE_URL: valid.TEST_DATABASE_URL },
    { ...valid, TEST_DATABASE_URL: 'postgresql://localhost/verzel_auction' },
    { ...valid, TEST_DATABASE_URL: 'postgresql://remote.example/verzel_auction_test' },
  ]) assert.throws(() => assertIsolatedDemoEnvironment(env));
});
