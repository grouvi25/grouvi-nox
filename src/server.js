import http from 'node:http';
import { config } from './config.js';
import { load, prune } from './store.js';
import { initDatabase } from './database.js';
import { attachWebsocket } from './ws.js';
import { startCollectors } from './metrics/index.js';
import { startAdminSocket } from './admin-socket.js';
import { createApp } from './app.js';
import { startFleetPush } from './fleet.js';
import { startUpdateChecks } from './updates.js';

const app = createApp();

const server = http.createServer(app);
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

attachWebsocket(server);
startAdminSocket();
startCollectors();
startUpdateChecks();
startFleetPush();

server.listen(config.port, config.host, () => {
  console.log(`[grouvi-nox] listening on http://${config.host}:${config.port} (rp: ${config.rpID})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[grouvi-nox] ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
