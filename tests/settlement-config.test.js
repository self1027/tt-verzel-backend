import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSettlementInterval } from '../src/shared/config.ts';

test('settlement polling is configurable and bounded against busy loops', () => {
  assert.equal(readSettlementInterval({}), 2000);
  assert.equal(readSettlementInterval({ SETTLEMENT_POLL_MS: '1000' }), 1000);
  for (const value of ['0', '-1', '50', '100.5', '60001', 'invalid']) assert.throws(() => readSettlementInterval({ SETTLEMENT_POLL_MS: value }));
});
