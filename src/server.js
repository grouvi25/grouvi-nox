import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { load, prune } from './store.js';
import { securityHeaders, rateLimit } from './security.js';
import { currentSession } from './auth.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import { attachWebsocket } from './ws.js';
import { startCollectors } from './metrics/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

load();
prune();
setInterval(prune, 10 * 60_000).unref();

const app = express();
app.disable('x-powered-by');
app.disable('etag');
app.set('trust proxy', 1);

app.use(securityHeaders);
app.use(rateLimit({ windowMs: 60_000, max: 600, name: 'global' }));
app.use(express.json({ limit: '32kb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);

const sendPage = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, file));
};

app.get('/', (req, res, next) => {
  if (!currentSession(req)) return res.redirect(302, '/login');
  return sendPage('index.html')(req, res, next);
});
app.get('/login', sendPage('login.html'));
app.get('/enroll', sendPage('enroll.html'));

app.use(express.static(publicDir, {
  index: false,
  dotfiles: 'deny',
  maxAge: '10m',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err?.message || err);
  res.status(500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

attachWebsocket(server);
startCollectors();

server.listen(config.port, config.host, () => {
  console.log(`[vps-sentinel] listening on http://${config.host}:${config.port} (rp: ${config.rpID})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[vps-sentinel] ${sig}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
