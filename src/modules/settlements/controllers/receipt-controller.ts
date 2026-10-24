import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ReceiptUseCases } from '../contracts/receipt.js';

const idInput = z.uuid().transform(value => value.toLowerCase());
const noQuery = z.strictObject({});

export class ReceiptController {
  constructor(private readonly receipts: ReceiptUseCases) {}

  get = async (request: Request, response: Response): Promise<void> => {
    const id = idInput.parse(request.params.id);
    noQuery.parse(request.query);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ receipt: await this.receipts.get(id) });
  };
}
