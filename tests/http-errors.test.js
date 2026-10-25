import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Router } from 'express';
import { createApp } from '../src/app.ts';
import { serve } from './helpers/http.js';

test('unsupported JSON charset and content encoding return sanitized 415 before the route runs', async () => {
  let handled = 0;
  const router = Router();
  router.post('/login', (_request, response) => { handled++; response.json({ ok: true }); });
  const http = await serve(createApp(router));
  try {
    for (const headers of [
      { 'content-type': 'application/json; charset=iso-8859-1' },
      { 'content-type': 'application/json', 'content-encoding': 'not-an-encoding' },
    ]) {
      const response = await fetch(`${http.url}/auth/login`, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 415);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request body charset or encoding' } });
    }
    assert.equal(handled, 0);
  } finally { await http.close(); }
});

test('JSON parser controls keep 400/413 and unknown server exceptions remain sanitized 500', async () => {
  const router = Router();
  router.post('/login', (_request, response) => { response.json({ ok: true }); });
  router.get('/failure', () => { throw Object.assign(new Error('private error detail'), { status: 415, type: 'unknown.type' }); });
  const http = await serve(createApp(router));
  try {
    for (const [body, status, code] of [
      ['{"private":"secret"', 400, 'INVALID_JSON'],
      [JSON.stringify({ value: 'x'.repeat(17000) }), 413, 'PAYLOAD_TOO_LARGE'],
    ]) {
      const response = await fetch(`${http.url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    }
    const valid = await fetch(`${http.url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
    assert.equal(valid.status, 200);
    const failure = await fetch(`${http.url}/auth/failure`);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  } finally { await http.close(); }
});
