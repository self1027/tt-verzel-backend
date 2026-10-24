import assert from 'node:assert/strict';
import { test } from 'node:test';

test('settlement defers unavailable/pending audit and flags tampering before opening a financial transaction', async () => {
  const { SettlementService } = await import('../src/modules/settlements/services/settlement-service.ts');
  const repository = { terminal: async () => null, transaction: () => assert.fail('must not acquire financial locks') };
  for (const status of ['PENDING_ANCHOR', 'VERIFICATION_UNAVAILABLE', 'TAMPERED']) {
    const incidents = [];
    const service = new SettlementService(repository, { inspect: async () => ({ status }) }, { publish: event => incidents.push(event) });
    const result = await service.settle('auction');
    assert.equal(result.status, status === 'TAMPERED' ? 'TAMPERED' : 'DEFERRED');
    assert.equal(incidents.length, status === 'TAMPERED' ? 1 : 0);
  }
});
