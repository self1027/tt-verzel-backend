import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import { createApp } from '../src/app.ts';
import { serve } from './helpers/http.js';

test('OpenAPI is served publicly with the configurable frontend CORS policy', async () => {
  const documentation = JSON.parse(await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'));
  const http = await serve(createApp(Router(), undefined, undefined, undefined, undefined,
    { documentation, corsOrigins: ['http://localhost:5173'] }));
  try {
    const response = await fetch(http.url + '/openapi.json', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.deepEqual(await response.json(), documentation);
  } finally { await http.close(); }
});
