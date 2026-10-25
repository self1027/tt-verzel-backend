import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from './app-error.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (error instanceof AppError) {
    if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ error: {
      code: 'VALIDATION_ERROR', message: 'Invalid request',
      details: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    } });
    return;
  }
  if (error instanceof Error && 'type' in error) {
    if (error.type === 'charset.unsupported' || error.type === 'encoding.unsupported') {
      response.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request body charset or encoding' } });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
      return;
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
      return;
    }
  }
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};
