import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthLocals } from '../../auth/middleware/authentication.js';
import type { AuctionUseCases } from '../contracts/auctions.js';
import { unauthenticated } from '../../../shared/http/app-error.js';

const money = z.string().regex(/^[1-9]\d*$/).max(19).transform(BigInt).pipe(z.bigint().max(9223372036854775807n));
const date = z.iso.datetime({ offset: true }).refine((value) => !/\.\d{4}/.test(value), 'At most millisecond precision is supported').transform((value) => new Date(value));
const terms = z.strictObject({ startingBidCents: money, minIncrementCents: money, startsAt: date, endsAt: date });
const createInput = terms.extend({ productSnapshotId: z.uuid() });
const editInput = terms.partial().refine((value) => Object.keys(value).length > 0, 'Provide at least one editable field');
const unsigned = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const price = z.string().regex(/^(0|[1-9]\d*)$/).max(19).transform(BigInt).pipe(z.bigint().max(9223372036854775807n));
const listInput = z.strictObject({
  limit: unsigned.pipe(z.number().min(1).max(100)).default(30),
  skip: unsigned.pipe(z.number().max(2147483647)).optional(),
  page: unsigned.pipe(z.number().min(1).max(2147483648)).optional(),
  q: z.string().optional(),
  minPriceCents: price.optional(),
  maxPriceCents: price.optional(),
  sort: z.enum(['price_asc', 'price_desc', 'endsAt_asc', 'endsAt_desc']).optional(),
  lifecycleState: z.enum(['SCHEDULED', 'LIVE', 'FINALIZING', 'CANCELLED', 'SETTLED', 'CLOSED_NO_BIDS']).optional(),
}).refine((input) => input.page === undefined || input.skip === undefined, 'Use either page or skip')
  .refine((input) => input.minPriceCents === undefined || input.maxPriceCents === undefined || input.minPriceCents <= input.maxPriceCents, 'Minimum price must not exceed maximum')
  .refine((input) => input.page === undefined || (input.page - 1) * input.limit <= 2147483647, 'Page offset is too large')
  .transform((input) => ({ ...input, skip: input.page === undefined ? input.skip ?? 0 : (input.page - 1) * input.limit }));

function owner(response: Response<unknown, AuthLocals>): string {
  const user = response.locals.user;
  if (!user) throw unauthenticated();
  return user.id;
}

export class AuctionController {
  constructor(private readonly auctions: AuctionUseCases) {}

  create = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    response.status(201).json({ auction: await this.auctions.create(owner(response), createInput.parse(request.body)) });
  };

  list = async (request: Request, response: Response): Promise<void> => {
    response.json(await this.auctions.list(listInput.parse(request.query)));
  };

  mine = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    response.json(await this.auctions.mine(owner(response), listInput.parse(request.query)));
  };

  get = async (request: Request, response: Response): Promise<void> => {
    response.json({ auction: await this.auctions.get(z.uuid().parse(request.params.id)) });
  };

  edit = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    response.json({ auction: await this.auctions.edit(z.uuid().parse(request.params.id), owner(response), editInput.parse(request.body)) });
  };

  cancel = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    const id = z.uuid().parse(request.params.id);
    z.strictObject({}).parse(request.body ?? {});
    response.json({ auction: await this.auctions.cancel(id, owner(response)) });
  };
}
