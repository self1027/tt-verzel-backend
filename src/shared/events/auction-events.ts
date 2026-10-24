import type { JsonValue } from '../../modules/audit/contracts/audit.js';

export type AuctionEventType = 'bid:accepted' | 'auction:extended' | 'auction:ended' | 'auction:settled' | 'auction:cancelled' | 'auction:integrity-warning';
export interface AuctionEvent { type: AuctionEventType; auctionId: string; data: Record<string, JsonValue> }
/** Best-effort public hints AFTER COMMIT. REST remains authoritative; no durable delivery claim. */
export interface AuctionEventSink { publish(event: AuctionEvent): void }
export const silentAuctionEvents: AuctionEventSink = { publish() {} };
