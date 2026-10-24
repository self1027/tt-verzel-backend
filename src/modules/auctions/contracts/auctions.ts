import type { ProductSnapshot } from '../../catalog/contracts/catalog.js';

export type AuctionStatus = 'PUBLISHED' | 'CANCELLED' | 'SETTLED' | 'CLOSED_NO_BIDS';
export type LifecycleState = 'SCHEDULED' | 'LIVE' | 'FINALIZING' | Exclude<AuctionStatus, 'PUBLISHED'>;

export interface CreateAuctionInput {
  productSnapshotId: string;
  startingBidCents: bigint;
  minIncrementCents: bigint;
  startsAt: Date;
  endsAt: Date;
}

export interface EditAuctionInput {
  startingBidCents?: bigint | undefined;
  minIncrementCents?: bigint | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
}

export interface Auction extends CreateAuctionInput {
  id: string;
  auctioneerId: string;
  currentBidId: string | null;
  status: AuctionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuctionWithSnapshot extends Auction {
  productSnapshot: ProductSnapshot;
}

export interface AuctionView extends Omit<AuctionWithSnapshot, 'startingBidCents' | 'minIncrementCents'> {
  startingBidCents: string;
  minIncrementCents: string;
  lifecycleState: LifecycleState;
}

export interface AuctionListInput {
  limit: number;
  skip: number;
  page?: number | undefined;
  q?: string | undefined;
  minPriceCents?: bigint | undefined;
  maxPriceCents?: bigint | undefined;
  sort?: 'price_asc' | 'price_desc' | 'endsAt_asc' | 'endsAt_desc' | undefined;
  lifecycleState?: LifecycleState | undefined;
}

export interface AuctionQuery extends AuctionListInput {
  auctioneerId?: string;
}

export interface AuctionPage<T> {
  auctions: T[];
  total: number;
  limit: number;
  skip: number;
  asOf: Date;
}

export type AuctionMutation = Partial<Pick<Auction, 'startingBidCents' | 'minIncrementCents' | 'startsAt' | 'endsAt' | 'status'>> & { updatedAt: Date };

export interface AuctionWriteContext {
  lock(id: string): Promise<Auction | null>;
  databaseNow(): Promise<Date>;
  snapshotExists(id: string): Promise<boolean>;
  hasBids(id: string): Promise<boolean>;
  insert(auction: Auction): Promise<AuctionWithSnapshot>;
  update(id: string, changes: AuctionMutation): Promise<AuctionWithSnapshot>;
}

export interface AuctionRepository {
  transaction<T>(work: (tx: AuctionWriteContext) => Promise<T>): Promise<T>;
  list(input: AuctionQuery): Promise<AuctionPage<AuctionWithSnapshot>>;
  findById(id: string): Promise<{ auction: AuctionWithSnapshot | null; asOf: Date }>;
}

export interface AuctionUseCases {
  create(auctioneerId: string, input: CreateAuctionInput): Promise<AuctionView>;
  list(input: AuctionListInput): Promise<AuctionPage<AuctionView>>;
  mine(auctioneerId: string, input: AuctionListInput): Promise<AuctionPage<AuctionView>>;
  get(id: string): Promise<AuctionView>;
  edit(id: string, auctioneerId: string, input: EditAuctionInput): Promise<AuctionView>;
  cancel(id: string, auctioneerId: string): Promise<AuctionView>;
}
