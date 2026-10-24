import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuctionController } from '../src/modules/auctions/controllers/auction-controller.ts';

async function parse(query) {
  let output;
  const controller = new AuctionController({ list: async (input) => input });
  await controller.list({ query }, { json(value) { output = value; } });
  return output;
}

test('list query preserves defaults and translates one-based pages without precision loss', async () => {
  assert.deepEqual(await parse({}), { limit: 30, skip: 0 });
  assert.deepEqual(await parse({ limit: '2', page: '3', q: 'Local', minPriceCents: '0', maxPriceCents: '9223372036854775807', sort: 'price_desc' }),
    { limit: 2, page: 3, skip: 4, q: 'Local', minPriceCents: 0n, maxPriceCents: 9223372036854775807n, sort: 'price_desc' });
  assert.equal((await parse({ page: '2147483648', limit: '1' })).skip, 2147483647);
});

test('list query rejects ambiguous, overflowing, repeated and noncanonical filters', async () => {
  const invalid = [
    { page: '1', skip: '0' }, { page: '0' }, { page: '2147483649', limit: '1' },
    { minPriceCents: '2', maxPriceCents: '1' }, { q: ['a', 'b'] }, { q: { text: 'a' } },
    { sort: ['price_asc', 'price_desc'] }, { sort: 'title' }, { extra: 'x' },
  ];
  for (const value of ['-1', '01', '1.1', '1e2', '+1', '9223372036854775808', '', 1]) {
    invalid.push({ minPriceCents: value }, { maxPriceCents: value });
  }
  for (const query of invalid) await assert.rejects(parse(query), undefined, JSON.stringify(query));
});
