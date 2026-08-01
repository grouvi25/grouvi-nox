#!/usr/bin/env node
/**
 * Privileged side-car.
 *
 * Runs as root, isolated from the web process, and does exactly two things:
 * `pm2 jlist` and `fail2ban-client status sshd`. The result is dumped to a
 * world-readable JSON file that the (unprivileged) dashboard reads.
 *
 * This exists so the internet-facing process never holds, and never needs,
 * any way to escalate privileges.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const STATE_DIR = process.env.STATE_DIR || '/var/lib/vps-sentinel';
const OUT = path.join(STATE_DIR, 'privileged.json');
const INTERVAL = Number(process.env.PRIV_INTERVAL_MS || 15000);
const PM2_BIN = process.env.PM2_BIN || '/usr/bin/pm2';
const F2B_BIN = process.env.FAIL2BAN_BIN || '/usr/bin/fail2ban-client';

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL', env: { ...process.env, HOME: '/root' } },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

async function pm2() {
  const out = await run(PM2_BIN, ['jlist']);
  if (!out) return { available: false, items: [] };
  const start = out.indexOf('[');
  if (start < 0) return { available: false, items: [] };
  let list;
  try { list = JSON.parse(out.slice(start)); } catch { return { available: false, items: [] }; }
  if (!Array.isArray(list)) return { available: false, items: [] };

  const items = list.map(p => ({
    name: p.name,
    pid: p.pid || null,
    status: p.pm2_env?.status || 'unknown',
    restarts: p.pm2_env?.restart_time ?? 0,
    unstableRestarts: p.pm2_env?.unstable_restarts ?? 0,
    uptimeMs: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    execMode: p.pm2_env?.exec_mode || 'fork',
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    available: true,
    items,
    online: items.filter(i => i.status === 'online').length,
    down: items.filter(i => i.status !== 'online').length,
  };
}

async function fail2ban() {
  const out = await run(F2B_BIN, ['status', 'sshd']);
  if (!out) return { available: false };
  const num = (re) => Number(re.exec(out)?.[1] ?? 0);
  return {
    available: true,
    currentlyBanned: num(/Currently banned:\s+(\d+)/),
    totalBanned: num(/Total banned:\s+(\d+)/),
    currentlyFailed: num(/Currently failed:\s+(\d+)/),
    totalFailed: num(/Total failed:\s+(\d+)/),
  };
}

async function tick() {
  try {
    const [p, f] = await Promise.all([pm2(), fail2ban()]);
    const payload = JSON.stringify({ at: Date.now(), pm2: p, fail2ban: f });
    const tmp = `${OUT}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o644 });
    fs.renameSync(tmp, OUT);
    fs.chmodSync(OUT, 0o644);
  } catch (e) {
    console.error('[privileged]', e.message);
  }
}

fs.mkdirSync(STATE_DIR, { recursive: true });
await tick();
setInterval(tick, INTERVAL);
console.log(`[privileged] writing ${OUT} every ${INTERVAL} ms`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
