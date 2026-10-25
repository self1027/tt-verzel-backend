import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createAuthModule } from './modules/auth/index.js';
import { createAuctionModule } from './modules/auctions/index.js';
import { createCatalogModule } from './modules/catalog/index.js';
import { createWalletModule } from './modules/wallets/index.js';
import { createAuditModule } from './modules/audit/index.js';
import { createSettlementModule } from './modules/settlements/index.js';
import { attachAuctionSockets } from './modules/realtime/auction-sockets.js';
import { readCorsOrigins } from './shared/http/cors.js';
import { silentAuctionEvents, type AuctionEventSink } from './shared/events/auction-events.js';
import { readAuditConfig } from './modules/audit/infrastructure/config.js';
import { HttpAnchorProvider } from './modules/audit/infrastructure/http-anchor-provider.js';
import { DummyJsonProvider } from './modules/catalog/infrastructure/dummyjson-provider.js';
import { readAuthConfig, readCatalogTimeout, readDatabaseURL, readPort, readSettlementInterval } from './shared/config.js';
import { createDatabase } from './shared/database/client.js';

async function main(): Promise<void> {
  const config = readAuthConfig(process.env);
  const port = readPort(process.env);
  const catalogTimeout = readCatalogTimeout(process.env);
  const auditConfig = readAuditConfig(process.env);
  const settlementInterval = readSettlementInterval(process.env);
  const documentation: unknown = parse(await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'));
  const external = auditConfig ? new HttpAnchorProvider({ baseUrl: auditConfig.baseUrl, namespace: auditConfig.namespace,
    publicKey: await readFile(auditConfig.publicKeyFile, 'utf8'), timeoutMs: auditConfig.timeoutMs,
    allowInsecureHttpForDevelopment: auditConfig.allowInsecureHttpForDevelopment,
    ...(auditConfig.publishToken ? { publishToken: auditConfig.publishToken } : {}) }) : undefined;
  const { db, pool } = createDatabase(readDatabaseURL(process.env));
  try {
    await pool.query('SELECT 1');
    const auth = await createAuthModule(db, config);
    const catalog = createCatalogModule(db, auth.authenticate, new DummyJsonProvider({ timeoutMs: catalogTimeout }));
    let activeEvents: AuctionEventSink = silentAuctionEvents;
    const events: AuctionEventSink = { publish: event => { activeEvents.publish(event); } };
    const auctionRouter = createAuctionModule(db, auth.authenticate, events);
    const walletRouter = createWalletModule(db, auth.authenticate);
    const audit = createAuditModule(db, external);
    const settlement = createSettlementModule(db, external, events);
    const origins = readCorsOrigins(process.env);
    let workerTask: Promise<unknown> = Promise.resolve();
    let publishing = false;
    const publish = (): void => {
      if (publishing) return;
      publishing = true;
      workerTask = audit.worker.runOnce().then(({ failed, blocked }) => {
        if (failed) console.error(`Audit anchors pending retry: ${String(failed)}`);
        if (blocked) console.warn(`Audit anchors withheld: ${String(blocked)}; audit state is invalid`);
      }).catch(() => { console.error('Audit publication temporarily unavailable'); }).finally(() => { publishing = false; });
    };
    const timer = auditConfig?.publishToken ? setInterval(publish, auditConfig.pollMs) : undefined;
    timer?.unref();
    if (timer) publish();
    const server = createServer(createApp(auth.router, catalog, auctionRouter, walletRouter, audit.router, { corsOrigins: origins, documentation }));
    const sockets = attachAuctionSockets(server, origins);
    activeEvents = sockets.events;
    settlement.worker.start(settlementInterval);
    server.listen(port, () => {
      console.log(`Server is running on port ${String(port)}`);
    });
    server.on('error', () => {
      console.error('HTTP server failed');
      clearInterval(timer);
      void Promise.allSettled([workerTask, settlement.worker.stop(), sockets.close()]).then(() => pool.end()).finally(() => { process.exitCode = 1; });
    });
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      void Promise.allSettled([workerTask, settlement.worker.stop(), sockets.close()]).then(() => pool.end());
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
