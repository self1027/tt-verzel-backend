import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import { createApp } from '../src/app.ts';
import { serve } from './helpers/http.js';

test('OpenAPI is served publicly with the configurable frontend CORS policy', async () => {
  const documentation = parse(await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
  const http = await serve(createApp(Router(), undefined, undefined, undefined, undefined,
    { documentation, corsOrigins: ['http://localhost:5173'] }));
  try {
    const response = await fetch(http.url + '/openapi.json', { headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.deepEqual(await response.json(), documentation);
    const ui = await fetch(http.url + '/docs/');
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /swagger-ui/);
    const initialization = await fetch(http.url + '/docs/swagger-ui-init.js');
    assert.equal(initialization.status, 200);
    assert.match(await initialization.text(), /\/openapi.yaml/);
    const assets = await fetch(http.url + '/docs/swagger-ui-bundle.js');
    assert.equal(assets.status, 200);
    const yaml = await fetch(http.url + '/openapi.yaml');
    assert.equal(yaml.status, 200);
    assert.match(yaml.headers.get('content-type'), /yaml/);
    assert.deepEqual(parse(await yaml.text()), documentation);
  } finally { await http.close(); }
});
