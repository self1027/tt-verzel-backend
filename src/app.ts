import express, { type Express, type Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { stringify } from 'yaml';
import { AppError } from './shared/http/app-error.js';
import { errorHandler } from './shared/http/error-handler.js';
import { corsMiddleware } from './shared/http/cors.js';

export function createApp(authRouter: Router, catalogRouter?: Router, auctionRouter?: Router, walletRouter?: Router, auditRouter?: Router, options: { corsOrigins?: string[]; documentation?: unknown; trustedProxies?: string[] } = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustedProxies ?? []);
  app.use(corsMiddleware(options.corsOrigins ?? []));
  app.use(express.json({ limit: '16kb' }));
  if (options.documentation) {
    app.get('/openapi.json', (_request, response) => { response.json(options.documentation); });
    app.get('/openapi.yaml', (_request, response) => { response.type('application/yaml').send(stringify(options.documentation)); });
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(undefined, {
      swaggerOptions: { url: '/openapi.yaml', validatorUrl: null },
      customSiteTitle: 'Verzel API',
    }));
  }
  app.use('/auth', authRouter);
  if (catalogRouter) app.use('/catalog', catalogRouter);
  if (auctionRouter) app.use('/auctions', auctionRouter);
  if (walletRouter) app.use('/wallet', walletRouter);
  if (auditRouter) app.use('/auctions', auditRouter);
  app.use(() => { throw new AppError(404, 'NOT_FOUND', 'Route not found'); });
  app.use(errorHandler);
  return app;
}
