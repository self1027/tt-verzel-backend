import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createAuthModule } from './modules/auth/index.js';
import { createAuctionModule } from './modules/auctions/index.js';
import { createCatalogModule } from './modules/catalog/index.js';
import { createWalletModule } from './modules/wallets/index.js';
import { createAuditModule } from './modules/audit/index.js';
import { readAuditConfig } from './modules/audit/infrastructure/config.js';
import { HttpAnchorProvider } from './modules/audit/infrastructure/http-anchor-provider.js';
import { DummyJsonProvider } from './modules/catalog/infrastructure/dummyjson-provider.js';
import { readAuthConfig, readCatalogTimeout, readDatabaseURL, readPort } from './shared/config.js';
import { createDatabase } from './shared/database/client.js';

async function main(): Promise<void> {
  const config = readAuthConfig(process.env);
  const port = readPort(process.env);
  const catalogTimeout = readCatalogTimeout(process.env);
  const auditConfig = readAuditConfig(process.env);
  const external = auditConfig ? new HttpAnchorProvider({ baseUrl: auditConfig.baseUrl, namespace: auditConfig.namespace,
    publicKey: await readFile(auditConfig.publicKeyFile, 'utf8'), timeoutMs: auditConfig.timeoutMs,
    allowInsecureHttpForDevelopment: auditConfig.allowInsecureHttpForDevelopment,
    ...(auditConfig.publishToken ? { publishToken: auditConfig.publishToken } : {}) }) : undefined;
  const { db, pool } = createDatabase(readDatabaseURL(process.env));
  try {
    await pool.query('SELECT 1');
    const auth = await createAuthModule(db, config);
    const catalog = createCatalogModule(db, auth.authenticate, new DummyJsonProvider({ timeoutMs: catalogTimeout }));
    const auctionRouter = createAuctionModule(db, auth.authenticate);
    const walletRouter = createWalletModule(db, auth.authenticate);
    const audit = createAuditModule(db, external);
    let workerTask: Promise<unknown> = Promise.resolve();
    let publishing = false;
    const publish = (): void => {
      if (publishing) return;
      publishing = true;
      workerTask = audit.worker.runOnce().then(({ failed }) => {
        if (failed) console.error(`Audit anchors pending retry: ${String(failed)}`);
      }).catch(() => { console.error('Audit publication temporarily unavailable'); }).finally(() => { publishing = false; });
    };
    const timer = auditConfig?.publishToken ? setInterval(publish, auditConfig.pollMs) : undefined;
    timer?.unref();
    if (timer) publish();
    const server = createApp(auth.router, catalog, auctionRouter, walletRouter, audit.router).listen(port, () => {
      console.log(`Server is running on port ${String(port)}`);
    });
    server.on('error', () => {
      console.error('HTTP server failed');
      clearInterval(timer);
      void workerTask.then(() => pool.end()).finally(() => { process.exitCode = 1; });
    });
    const shutdown = (): void => {
      clearInterval(timer);
      server.close(() => { void workerTask.then(() => pool.end()); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch(() => {
  console.error('Startup failed. Check database and authentication configuration.');
  process.exitCode = 1;
});
