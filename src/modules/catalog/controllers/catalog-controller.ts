import type { Request, Response } from 'express';
import { z } from 'zod';
import type { CatalogUseCases } from '../contracts/catalog.js';

const unsignedInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative());
const limit = unsignedInteger.pipe(z.number().min(1).max(100)).default(30);
const skip = unsignedInteger.pipe(z.number().max(2147483647)).default(0);
const pagination = z.strictObject({ limit, skip });
const productList = pagination.extend({ q: z.string().trim().max(200).optional() });
const externalList = pagination.extend({ category: z.string().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional() });
const externalSearch = pagination.extend({ q: z.string().trim().min(1).max(200) });
const externalId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive());

export class CatalogController {
  constructor(private readonly catalog: CatalogUseCases) {}

  listExternal = async (request: Request, response: Response): Promise<void> => {
    response.json(await this.catalog.listExternal(externalList.parse(request.query)));
  };

  searchExternal = async (request: Request, response: Response): Promise<void> => {
    const { q, ...page } = externalSearch.parse(request.query);
    response.json(await this.catalog.searchExternal(q, page));
  };

  getExternal = async (request: Request, response: Response): Promise<void> => {
    response.json({ product: await this.catalog.getExternal(externalId.parse(request.params.id)) });
  };

  categories = async (_request: Request, response: Response): Promise<void> => {
    response.json(await this.catalog.listCategories());
  };

  importProduct = async (request: Request, response: Response): Promise<void> => {
    const id = externalId.parse(request.params.id);
    z.strictObject({}).parse(request.body ?? {});
    const result = await this.catalog.importProduct(id);
    response.status(result.created ? 201 : 200).json(result);
  };

  listProducts = async (request: Request, response: Response): Promise<void> => {
    const { q, ...page } = productList.parse(request.query);
    response.json(await this.catalog.listProducts(page, q));
  };

  getProduct = async (request: Request, response: Response): Promise<void> => {
    response.json({ product: await this.catalog.getProduct(z.uuid().parse(request.params.id)) });
  };
}
