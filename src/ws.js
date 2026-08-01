import { WebSocketServer } from 'ws';
import * as cookie from 'cookie';
import { config } from './config.js';
import { SESSION_COOKIE, verifySessionToken } from './auth.js';
import { bus, publicSnapshot } from './metrics/index.js';

export function attachWebsocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, config.origin);
    if (url.pathname !== '/stream') {
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (origin && origin !== config.origin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let cookies = {};
    try { cookies = cookie.parse(req.headers.cookie || ''); } catch { /* ignore */ }
    const session = verifySessionToken(cookies[SESSION_COOKIE]);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionExpiresAt = session.exp;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', () => { /* client is read-only; ignore everything */ });
    ws.on('error', () => ws.terminate());

    try {
      ws.send(JSON.stringify({ type: 'snapshot', data: publicSnapshot() }));
    } catch { /* ignore */ }
  });

  const onTick = (data) => {
    const payload = JSON.stringify({ type: 'tick', data });
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.sessionExpiresAt && Date.now() > ws.sessionExpiresAt) { ws.close(4001, 'session expired'); continue; }
      ws.send(payload, () => {});
    }
  };
  bus.on('tick', onTick);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return wss;
}
