import assert from 'node:assert/strict';
import { test } from 'node:test';

test('audit witness is disabled explicitly and partial configuration fails startup', async () => {
  const { readAuditConfig } = await import('../src/modules/audit/infrastructure/config.ts');
  assert.equal(readAuditConfig({}), null);
  assert.equal(readAuditConfig({ AUDIT_WITNESS_URL: '' }), null);
  assert.throws(() => readAuditConfig({ AUDIT_WITNESS_NAMESPACE: 'test' }));
  assert.throws(() => readAuditConfig({ AUDIT_WITNESS_URL: 'https://example.test' }));
  const base = { AUDIT_WITNESS_URL: 'https://example.test', AUDIT_WITNESS_NAMESPACE: 'test', AUDIT_WITNESS_PUBLIC_KEY_FILE: 'public.pem' };
  assert.equal(readAuditConfig(base).pollMs, 5000);
  assert.equal(readAuditConfig(base).publishToken, undefined);
  assert.throws(() => readAuditConfig({ ...base, AUDIT_ANCHOR_POLL_MS: '0' }));
  assert.throws(() => readAuditConfig({ ...base, AUDIT_WITNESS_URL: 'file:///tmp/proof' }));
});

test('HTTP outside loopback requires an explicit development-only opt-in', async () => {
  const { readAuditConfig } = await import('../src/modules/audit/infrastructure/config.ts');
  const base = { AUDIT_WITNESS_URL: 'http://audit-witness:8081', AUDIT_WITNESS_NAMESPACE: 'dev', AUDIT_WITNESS_PUBLIC_KEY_FILE: 'public.pem' };
  assert.equal(readAuditConfig(base).allowInsecureHttpForDevelopment, false);
  assert.throws(() => readAuditConfig({ ...base, AUDIT_WITNESS_ALLOW_INSECURE_HTTP: 'true' }));
  assert.throws(() => readAuditConfig({ ...base, NODE_ENV: 'production', AUDIT_WITNESS_ALLOW_INSECURE_HTTP: 'true' }));
  assert.equal(readAuditConfig({ ...base, NODE_ENV: 'development', AUDIT_WITNESS_ALLOW_INSECURE_HTTP: 'true' }).allowInsecureHttpForDevelopment, true);
  assert.throws(() => readAuditConfig({ ...base, NODE_ENV: 'development', AUDIT_WITNESS_ALLOW_INSECURE_HTTP: 'yes' }));
});
