import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AuctionController } from '../src/modules/auctions/controllers/auction-controller.ts';

const load = () => readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8').then(parse);
const verbs = new Set(['get', 'post', 'patch', 'put', 'delete', 'options', 'head']);

test('OpenAPI resolves local references and declares every required path argument', async () => {
  const spec = await load();
  assert.equal(spec.openapi, '3.1.0');
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'));
      let target = spec;
      for (const key of value.$ref.slice(2).split('/')) target = target?.[key.replaceAll('~1', '/').replaceAll('~0', '~')];
      assert.ok(target, value.$ref);
    }
    Object.values(value).forEach(visit);
  }
  visit(spec);
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [verb, operation] of Object.entries(item)) {
      if (!verbs.has(verb)) continue;
      const params = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(p => p.$ref ? spec.components.parameters[p.$ref.split('/').at(-1)] : p);
      for (const match of path.matchAll(/\{([^}]+)\}/g)) assert.ok(params.some(p => p.in === 'path' && p.name === match[1] && p.required === true), `${verb} ${path}: ${match[1]}`);
      assert.ok(operation.responses['200'] || operation.responses['201'], `${verb} ${path}`);
    }
  }
});

test('OpenAPI covers public and protected consumer routes with receipt and filters', async () => {
  const spec = await load();
  for (const [path, methods] of Object.entries({
    '/auth/login': ['post'], '/auth/me': ['get'], '/catalog/external': ['get'], '/catalog/external/search': ['get'],
    '/catalog/external/{id}': ['get'], '/catalog/categories': ['get'], '/catalog/import/{id}': ['post'],
    '/catalog/products': ['get'], '/catalog/products/{id}': ['get'], '/wallet': ['get'], '/wallet/deposits': ['post'],
    '/wallet/transactions': ['get'], '/auctions': ['get', 'post'], '/auctions/mine': ['get'], '/auctions/{id}': ['get', 'patch'],
    '/auctions/{id}/cancel': ['post'], '/auctions/{auctionId}/bids': ['get', 'post'], '/auctions/bids/mine': ['get'],
    '/auctions/{id}/audit': ['get'], '/auctions/{id}/audit/events': ['get'], '/auctions/{id}/receipt': ['get'],
  })) for (const method of methods) assert.ok(spec.paths[path]?.[method], `${method} ${path}`);
  assert.deepEqual(spec.paths['/auctions'].get.security, []);
  assert.deepEqual(spec.paths['/auctions/{id}/receipt'].get.security, []);
  assert.deepEqual(spec.paths['/auctions'].post.security, [{ bearerAuth: [] }]);
  assert.equal(spec.paths['/auctions/{id}/receipt'].get.responses['404'].$ref, '#/components/responses/Error');
  assert.ok(!Object.keys(spec.paths).some(path => /admin|settle$/.test(path)));
});

test('documented list enums are accepted by the controller and price boundaries reject overflow', async () => {
  const spec = await load();
  const parameters = spec.paths['/auctions'].get.parameters.map(p => p.$ref ? spec.components.parameters[p.$ref.split('/').at(-1)] : p);
  const query = Object.fromEntries(parameters.map(p => [p.name, p]));
  for (const key of ['q', 'lifecycleState', 'minPriceCents', 'maxPriceCents', 'sort', 'page', 'limit', 'skip']) assert.ok(query[key], key);
  assert.deepEqual(query.sort.schema.enum, ['price_asc', 'price_desc', 'endsAt_asc', 'endsAt_desc']);
  assert.deepEqual(query.lifecycleState.schema.enum, ['SCHEDULED', 'LIVE', 'FINALIZING', 'CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']);
  async function parse(input) {
    const controller = new AuctionController({ list: async value => value });
    await controller.list({ query: input }, { json() {} });
  }
  for (const key of ['sort', 'lifecycleState']) {
    assert.ok(query[key].schema.enum.length > 0);
    for (const value of query[key].schema.enum) await parse({ [key]: value });
    await assert.rejects(parse({ [key]: 'INVALID' }));
  }
  const cents = spec.components.schemas.NonnegativeCents;
  for (const value of ['0', '9007199254740993', '9223372036854775807']) {
    assert.match(value, new RegExp(cents.pattern));
    await parse({ minPriceCents: value });
  }
  for (const value of ['01', '-1', '1.1', '9223372036854775808']) {
    assert.doesNotMatch(value, new RegExp(cents.pattern));
    await assert.rejects(parse({ minPriceCents: value }));
  }
});
