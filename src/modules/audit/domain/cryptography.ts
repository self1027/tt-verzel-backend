import { createHash } from 'node:crypto';
import type { AuditEvent, AuditInput } from '../contracts/audit.js';

export const GENESIS_HASH = '0'.repeat(64);
const MAX_BIGINT = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Only JSON data properties participate; never invoke accessors or toJSON. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) throw new Error('Invalid JSON number');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new Error('Invalid JSON value');
    if (active.has(item)) throw new Error('Cyclic JSON value');
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error('Invalid JSON prototype');
    }
    const keys = Reflect.ownKeys(item);
    if (keys.some(key => typeof key !== 'string')) throw new Error('Invalid JSON key');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key as string];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('Invalid JSON property');
    }
    active.add(item);
    let result: string;
    if (array) {
      if (keys.length !== item.length + 1) throw new Error('Invalid JSON array');
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor)) throw new Error('Sparse JSON array');
        values.push(encode(descriptor.value));
      }
      result = `[${values.join(',')}]`;
    } else {
      result = `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key]?.value)}`).join(',')}}`;
    }
    active.delete(item);
    return result;
  }
  return encode(value);
}

function fields(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new Error('Unexpected audit fields');
}

function uuid(value: unknown): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid UUID');
}

function hash(value: unknown): void {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Invalid SHA-256 hash');
}

function decimal(value: unknown, positive = false): void {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > MAX_BIGINT || (positive && value === '0')) {
    throw new Error('Invalid BIGINT decimal');
  }
}

function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('Invalid UTC timestamp');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error('Invalid UTC timestamp');
}

export function validateInput(input: AuditInput): void {
  canonicalJson(input);
  fields(input, ['auctionId', 'eventType', 'payload', 'createdAt']);
  uuid(input.auctionId);
  timestamp(input.createdAt);
  const payload = input.payload;
  switch (input.eventType) {
    case 'AUCTION_CREATED':
    case 'AUCTION_UPDATED':
    case 'AUCTION_CANCELLED':
      fields(payload, ['productSnapshotId', 'startingBidCents', 'minIncrementCents', 'startsAt', 'endsAt', 'status', 'currentBidId',
        ...(input.eventType === 'AUCTION_CANCELLED' && 'reason' in payload ? ['reason'] : [])]);
      if ('reason' in payload && payload.reason !== 'SELLER_REQUEST') throw new Error('Invalid cancellation reason');
      uuid(payload.productSnapshotId);
      decimal(payload.startingBidCents, true);
      decimal(payload.minIncrementCents, true);
      timestamp(payload.startsAt);
      timestamp(payload.endsAt);
      if (payload.startsAt >= payload.endsAt) throw new Error('Invalid auction interval');
      if (payload.status !== (input.eventType === 'AUCTION_CANCELLED' ? 'CANCELLED' : 'PUBLISHED')) throw new Error('Invalid auction status');
      if (payload.currentBidId !== null) uuid(payload.currentBidId);
      break;
    case 'BID_ACCEPTED':
      fields(payload, ['bidId', 'bidderRef', 'amountCents', 'bidSequence', 'createdAt', 'endsAt']);
      uuid(payload.bidId);
      hash(payload.bidderRef);
      decimal(payload.amountCents, true);
      decimal(payload.bidSequence, true);
      timestamp(payload.createdAt);
      timestamp(payload.endsAt);
      break;
    case 'AUCTION_SETTLED':
      fields(payload, ['settlementId', 'winningBidId', 'ledgerTransactionId', 'amountCents', 'settledAt', 'receiptHash']);
      uuid(payload.settlementId);
      uuid(payload.winningBidId);
      uuid(payload.ledgerTransactionId);
      decimal(payload.amountCents, true);
      timestamp(payload.settledAt);
      hash(payload.receiptHash);
      break;
    case 'AUCTION_CLOSED_NO_BIDS':
      fields(payload, []);
      break;
    default:
      throw new Error('Unsupported audit event type');
  }
}

export function hashEvent(event: Omit<AuditEvent, 'eventHash'>): string {
  fields(event, ['id', 'auctionId', 'sequence', 'eventType', 'payload', 'createdAt', 'previousHash', 'hashVersion']);
  validateInput({ auctionId: event.auctionId, eventType: event.eventType, payload: event.payload, createdAt: event.createdAt });
  uuid(event.id);
  hash(event.previousHash);
  if (event.hashVersion !== 1) throw new Error('Unsupported audit hash version');
  if (typeof event.sequence !== 'bigint' || event.sequence < 1n || event.sequence > MAX_BIGINT) throw new Error('Invalid audit sequence');
  return createHash('sha256').update('verzel:audit:event:v1\0').update(canonicalJson({
    id: event.id, auctionId: event.auctionId, sequence: event.sequence.toString(), eventType: event.eventType,
    payload: event.payload, createdAt: event.createdAt, previousHash: event.previousHash, hashVersion: '1',
  })).digest('hex');
}

export function checkChain(auctionId: string, events: AuditEvent[]): { valid: boolean; reason: string | null } {
  try {
    uuid(auctionId);
    let previousHash = GENESIS_HASH;
    let sequence = 1n;
    const ids = new Set<string>();
    for (const event of events) {
      if (event.auctionId !== auctionId) throw new Error('Audit auction mismatch');
      if (event.sequence !== sequence) throw new Error('Audit sequence gap or reordering');
      if (event.previousHash !== previousHash) throw new Error('Audit previous hash mismatch');
      if (ids.has(event.id)) throw new Error('Duplicate audit event ID');
      const { eventHash, ...unsigned } = event;
      hash(eventHash);
      if (hashEvent(unsigned) !== eventHash) throw new Error('Audit event hash mismatch');
      ids.add(event.id);
      previousHash = eventHash;
      sequence++;
    }
    return { valid: true, reason: null };
  } catch {
    // Do not reflect hostile payloads or identifiers into public verification results.
    return { valid: false, reason: 'Invalid audit chain' };
  }
}

export function bidderReference(auctionId: string, bidderId: string): string {
  uuid(auctionId);
  uuid(bidderId);
  return createHash('sha256').update('verzel:audit:bidder:v1\0').update(canonicalJson([auctionId, bidderId])).digest('hex');
}
