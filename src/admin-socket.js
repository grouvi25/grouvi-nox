import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import {
  createEnrollToken, generateRecoveryCodes, listCredentials,
} from './auth.js';
import { get, save } from './store.js';

/**
 * Local admin channel.
 *
 * The state file has exactly one writer: this process. Anything that needs to
 * mutate state (issuing enrollment links, minting recovery codes, revoking
 * sessions) goes through this Unix socket instead of editing the file behind
 * the service's back, which used to race and silently discard tokens.
 *
 * The socket lives in a root/service-only directory and speaks newline
 * delimited JSON. It is never exposed over the network.
 */

const MAX_REQUEST_BYTES = 4096;

function handle(msg) {
  switch (msg?.cmd) {
    case 'ping':
      return { ok: true, pong: true };

    case 'enroll': {
      const token = createEnrollToken(String(msg.note || 'cli').slice(0, 80));
      return {
        ok: true,
        url: `${config.origin}/enroll#${token}`,
        expiresInMin: Math.round(config.enrollTokenTtlMs / 60000),
        credentials: listCredentials().length,
      };
    }

    case 'recovery': {
      const codes = generateRecoveryCodes(10);
      return { ok: true, codes };
    }

    case 'status': {
      const st = get();
      return {
        ok: true,
        credentials: st.credentials.map(c => ({
          label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt,
          deviceType: c.deviceType, backedUp: c.backedUp,
        })),
        sessions: Object.keys(st.sessions).length,
        recoveryLeft: st.recoveryCodes.filter(r => !r.usedAt).length,
        pendingInvites: st.enrollTokens.filter(t => !t.usedAt && t.expiresAt > Date.now()).length,
      };
    }

    case 'revoke-sessions': {
      const st = get();
      const n = Object.keys(st.sessions).length;
      st.sessions = {};
      save();
      return { ok: true, revoked: n };
    }

    default:
      return { ok: false, error: 'unknown_command' };
  }
}

export function startAdminSocket() {
  const sockPath = config.adminSocket;
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(sockPath); } catch { /* not there */ }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.setTimeout(5000, () => sock.destroy());

    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) { sock.destroy(); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;

      let reply;
      try {
        reply = handle(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reply = { ok: false, error: e.message };
      }
      sock.end(`${JSON.stringify(reply)}\n`);
    });

    sock.on('error', () => sock.destroy());
  });

  server.listen(sockPath, () => {
    fs.chmodSync(sockPath, 0o600);
    console.log(`[grouvi-nox] admin socket at ${sockPath}`);
  });

  server.on('error', (e) => console.error('[admin-socket]', e.message));

  const cleanup = () => { try { fs.unlinkSync(sockPath); } catch { /* gone */ } };
  process.on('exit', cleanup);

  return server;
}
