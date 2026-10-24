import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { createApp } from '../src/app.ts';
import { readCorsOrigins } from '../src/shared/http/cors.ts';

test('CORS origins accept exact http origins and reject unsafe configuration', () => {
  assert.deepEqual(readCorsOrigins({}), []);
  assert.deepEqual(readCorsOrigins({ CORS_ORIGINS: ' https://example.com,http://localhost:3000,https://example.com ' }), ['https://example.com', 'http://localhost:3000']);
  for (const value of ['*', 'https://user:password@example.com', 'https://example.com/path', 'ftp://example.com', 'https://example.com?token=secret', 'https://example.com/#fragment']) {
    assert.throws(() => readCorsOrigins({ CORS_ORIGINS: value }), /Invalid CORS_ORIGINS/);
  }
});

test('configured origins receive preflight headers before routes, others do not', async t => {
  const app = createApp(express.Router(), undefined, undefined, undefined, undefined, { corsOrigins: ['https://example.com'] });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/auth/unknown`;
  const allowed = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://example.com');
  assert.match(allowed.headers.get('access-control-allow-headers'), /Idempotency-Key/);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  const denied = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const regular = await fetch(url, { headers: { Origin: 'https://example.com' } });
  assert.equal(regular.headers.get('access-control-allow-origin'), 'https://example.com');
});
