import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableConfig, isPgEnum, PgBigInt64, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '../src/shared/database/schema.ts';

const tables = Object.values(schema).filter((value) => is(value, PgTable));
const configs = new Map(tables.map((table) => {
  const config = getTableConfig(table);
  return [config.name, config];
}));

test('exports the domain and login budget tables and five enums', () => {
  assert.deepEqual([...configs.keys()].sort(), [
    'users', 'product_snapshots', 'auctions', 'bids', 'wallets',
    'wallet_reservations', 'ledger_accounts', 'ledger_transactions',
    'ledger_entries', 'auction_settlements', 'audit_events', 'audit_anchors',
    'bid_operations', 'login_rate_limits', 'auction_recoveries',
  ].sort());
  const enums = Object.values(schema).filter(isPgEnum);
  assert.deepEqual(Object.fromEntries(enums.map((item) => [item.enumName, item.enumValues])), {
    user_role: ['AUCTIONEER', 'BIDDER'],
    auction_status: ['PUBLISHED', 'CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS'],
    reservation_status: ['ACTIVE', 'RELEASED', 'CAPTURED'],
    ledger_account_type: ['USER_WALLET', 'SIMULATION_CLEARING'],
    ledger_transaction_type: ['DEPOSIT', 'AUCTION_SETTLEMENT'],
  });
});

test('preserves UUID primary keys, nullable fields, bigint precision and explicit defaults', () => {
  const nullable = {
    product_snapshots: ['description', 'image_url', 'attributes'],
    auctions: ['current_bid_id'], wallet_reservations: ['released_at'],
    ledger_accounts: ['wallet_id'], ledger_transactions: ['reference_id'],
    audit_anchors: ['external_reference', 'blocked_reason', 'blocked_at'],
    auction_recoveries: ['last_error', 'completed_at'],
  };
  for (const [name, config] of configs) {
    if (name === 'login_rate_limits') {
      assert.equal(config.columns.find(column => column.name === 'key').primary, true);
      continue;
    }
    const id = config.columns.find((column) => column.name === (name === 'auction_recoveries' ? 'auction_id' : 'id'));
    assert.equal(id.primary, true, name);
    assert.equal(id.getSQLType(), 'uuid', name);
    assert.deepEqual(config.columns.filter((column) => !column.notNull).map((column) => column.name).sort(), (nullable[name] ?? []).sort(), name);
    for (const column of config.columns) {
      if (column.getSQLType() === 'bigint') {
        assert.ok(is(column, PgBigInt64), `${name}.${column.name} must preserve bigint precision`);
      }
      if (column.getSQLType().startsWith('timestamp')) {
        assert.equal(column.getSQLType(), 'timestamp');
      }
      if (column.hasDefault && name === 'auction_recoveries') {
        assert.deepEqual({ state: 'PENDING', attempts: 0, released_cents: 0n, captured_cents: 0n }[column.name], column.default);
      } else if (column.hasDefault) {
        assert.equal(name, 'wallets');
        assert.ok(['balance_cents', 'reserved_cents'].includes(column.name));
        assert.equal(column.default, 0n);
      }
    }
  }
});

test('preserves all twenty foreign keys, including the circular auction bid reference', () => {
  const actual = [];
  for (const [name, config] of configs) {
    for (const key of config.foreignKeys) {
      const ref = key.reference();
      actual.push(`${name}.${ref.columns.map((column) => column.name).join(',')} -> ${getTableConfig(ref.foreignTable).name}.${ref.foreignColumns.map((column) => column.name).join(',')}`);
    }
  }
  assert.deepEqual(actual.sort(), [
    'auction_recoveries.auction_id -> auctions.id',
    'auctions.auctioneer_id -> users.id',
    'auctions.product_snapshot_id -> product_snapshots.id',
    'auctions.current_bid_id -> bids.id',
    'bids.auction_id -> auctions.id', 'bids.bidder_id -> users.id',
    'wallets.user_id -> users.id',
    'wallet_reservations.wallet_id -> wallets.id',
    'wallet_reservations.auction_id -> auctions.id',
    'wallet_reservations.bid_id -> bids.id',
    'ledger_accounts.wallet_id -> wallets.id',
    'ledger_entries.transaction_id -> ledger_transactions.id',
    'ledger_entries.account_id -> ledger_accounts.id',
    'auction_settlements.auction_id -> auctions.id',
    'auction_settlements.winning_bid_id -> bids.id',
    'auction_settlements.ledger_transaction_id -> ledger_transactions.id',
    'audit_events.auction_id -> auctions.id', 'audit_anchors.auction_id -> auctions.id',
    'bid_operations.user_id -> users.id', 'bid_operations.auction_id -> auctions.id', 'bid_operations.bid_id -> bids.id',
  ].sort());
});

test('preserves unique columns and ordered composite unique indexes', () => {
  const uniqueColumns = {};
  const indexes = {};
  for (const [name, config] of configs) {
    const columns = config.columns.filter((column) => column.isUnique).map((column) => column.name);
    if (columns.length) uniqueColumns[name] = columns;
    if (name === 'auction_recoveries') {
      assert.deepEqual(config.indexes.map(index => index.config.columns.map(column => column.name)), [['state', 'next_attempt_at']]);
      continue;
    }
    if (name === 'login_rate_limits') {
      assert.deepEqual(config.indexes.map(index => index.config.columns.map(column => column.name)), [['expires_at']]);
      continue;
    }
    if (config.indexes.length) {
      indexes[name] = config.indexes.map((index) => {
        assert.equal(index.config.unique, true);
        return index.config.columns.map((column) => column.name);
      });
    }
  }
  assert.deepEqual(uniqueColumns, {
    users: ['email'], wallets: ['user_id'], wallet_reservations: ['bid_id'],
    ledger_accounts: ['wallet_id'], ledger_transactions: ['idempotency_key'],
    auction_settlements: ['auction_id', 'winning_bid_id', 'ledger_transaction_id', 'receipt_token'],
    bid_operations: ['bid_id'],
  });
  assert.deepEqual(indexes, {
    bids: [['auction_id', 'sequence']],
    audit_events: [['auction_id', 'sequence']],
    audit_anchors: [['auction_id', 'last_sequence']],
    wallet_reservations: [['auction_id']],
    bid_operations: [['user_id', 'auction_id', 'key']],
  });
});
