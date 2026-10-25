import { createHash } from 'node:crypto';
import type { AuctionBinding } from '../contracts/audit.js';
import type { ProductSnapshot } from '../../catalog/contracts/catalog.js';
import { canonicalJson } from './cryptography.js';

/** The original binding is persisted only in the v2 genesis, never refreshed from mutable rows. */
export function auctionBinding(auctionId: string, sellerId: string,
  product: Omit<ProductSnapshot, 'capturedAt'> & { capturedAt: string }): AuctionBinding {
  return {
    sellerRef: createHash('sha256').update('verzel:audit:seller:v2\0').update(canonicalJson([auctionId, sellerId])).digest('hex'),
    productHash: createHash('sha256').update('verzel:audit:product:v2\0').update(canonicalJson(product, true)).digest('hex'),
  };
}
