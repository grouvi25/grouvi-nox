#!/usr/bin/env node
/**
 * Privileged read-only side-car.
 * Collects the two signals unavailable to the unprivileged web process:
 * PM2 state/log tails and fail2ban. It also reads git deployment metadata.
 * It never accepts commands from the network and only writes one JSON snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const STATE_DIR = process.env.STATE_DIR || '/var/lib/vps-sentinel';
const OUT = path.join(STATE_DIR, 'privileged.json');
const INTERVAL = Number(process.env.PRIV_INTERVAL_MS || 15000);
const PM2_BIN = process.env.PM2_BIN || '/usr/bin/pm2';
const F2B_BIN = process.env.FAIL2BAN_BIN || '/usr/bin/fail2ban-client';
const DEPLOY_DIRS = (process.env.DEPLOY_DIRS ||
  '/opt/mmo90s,/opt/reip,/opt/groovyhub,/opt/coursebot,/opt/vps-sentinel,/root/ijurist5modern')
  .split(',').map(s => s.trim()).filter(Boolean);

function run(cmd, args, timeout = 10000, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout, cwd, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL',
      env: { ...process.env, HOME: '/root' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function redact(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(password|passwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .slice(-24_000);
}

function tailFile(filePath, maxBytes = 12_000) {
  if (!filePath) return '';
  try {
    const st = fs.statSync(filePath);
    const length = Math.min(maxBytes, st.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, Math.max(0, st.size - length));
    fs.closeSync(fd);
    return redact(buf.toString('utf8')).split('\n').slice(-100).join('\n');
  } catch { return ''; }
}

async function pm2() {
  const result = await run(PM2_BIN, ['jlist']);
  if (!result.ok) return { available: false, items: [] };
  const start = result.stdout.indexOf('[');
  if (start < 0) return { available: false, items: [] };
  let list;
  try { list = JSON.parse(result.stdout.slice(start)); } catch { return { available: false, items: [] }; }
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
    cwd: p.pm2_env?.pm_cwd || null,
    script: p.pm2_env?.pm_exec_path || null,
    nodeVersion: p.pm2_env?.node_version || null,
    outLog: tailFile(p.pm2_env?.pm_out_log_path),
    errorLog: tailFile(p.pm2_env?.pm_err_log_path),
  })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    available: true, items,
    online: items.filter(i => i.status === 'online').length,
    down: items.filter(i => i.status !== 'online').length,
  };
}

async function fail2ban() {
  const result = await run(F2B_BIN, ['status', 'sshd']);
  if (!result.ok) return { available: false };
  const num = (re) => Number(re.exec(result.stdout)?.[1] ?? 0);
  return {
    available: true,
    currentlyBanned: num(/Currently banned:\s+(\d+)/),
    totalBanned: num(/Total banned:\s+(\d+)/),
    currentlyFailed: num(/Currently failed:\s+(\d+)/),
    totalFailed: num(/Total failed:\s+(\d+)/),
  };
}

async function deployments() {
  const projects = [];
  for (const dir of DEPLOY_DIRS) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    // Unit separator and record separator avoid commit-message parsing bugs.
    // eslint-disable-next-line no-await-in-loop
    const result = await run('git', ['log', '-12', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%ad%x1f%an%x1f%s%x1e'], 8000, dir);
    if (!result.ok) continue;
    const commits = result.stdout.split('\x1e').map(x => x.trim()).filter(Boolean).map(row => {
      const [sha, short, at, author, subject] = row.split('\x1f');
      return { sha, short, at, author, subject };
    });
    const branch = (await run('git', ['branch', '--show-current'], 3000, dir)).stdout.trim();
    const dirty = Boolean((await run('git', ['status', '--porcelain'], 3000, dir)).stdout.trim());
    projects.push({ project: path.basename(dir), dir, branch, dirty, commits });
  }
  return projects;
}

async function tick() {
  try {
    const [p, f, d] = await Promise.all([pm2(), fail2ban(), deployments()]);
    const payload = JSON.stringify({ at: Date.now(), pm2: p, fail2ban: f, deployments: d });
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
