import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthLocals } from '../../auth/middleware/authentication.js';
import { unauthenticated } from '../../../shared/http/app-error.js';
import { MAX_CENTS } from '../../ledger/contracts/ledger.js';
import type { BidUseCases } from '../contracts/bids.js';

const input = z.strictObject({ amountCents: z.string().max(19).regex(/^[1-9]\d*$/).transform(BigInt).pipe(z.bigint().max(MAX_CENTS)) });
const keyInput = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const auctionId = z.uuid().transform(value => value.toLowerCase());
const unsigned = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const pageInput = z.strictObject({ limit: unsigned.pipe(z.number().min(1).max(100)).default(30), skip: unsigned.pipe(z.number().max(2147483647)).default(0) });

function owner(response: Response<unknown, AuthLocals>): string {
  if (!response.locals.user) throw unauthenticated();
  return response.locals.user.id;
}

export class BidController {
  constructor(private readonly bids: BidUseCases) {}

  placeBid = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    const id = auctionId.parse(request.params.auctionId);
    const { amountCents } = input.parse(request.body);
    const headers = request.rawHeaders.filter((_, index) => index % 2 === 0).filter((header) => header.toLowerCase() === 'idempotency-key');
    const key = keyInput.parse(headers.length === 1 ? request.get('Idempotency-Key') : undefined);
    response.status(201).json({ bid: await this.bids.placeBid(owner(response), id, amountCents, key) });
  };

  history = async (request: Request, response: Response): Promise<void> => {
    response.json(await this.bids.history(auctionId.parse(request.params.auctionId), pageInput.parse(request.query)));
  };

  mine = async (request: Request, response: Response<unknown, AuthLocals>): Promise<void> => {
    response.json(await this.bids.mine(owner(response), pageInput.parse(request.query)));
  };
}
