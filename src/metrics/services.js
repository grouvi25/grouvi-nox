import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from '../config.js';

function run(cmd, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err }));
  });
}

/* ---------------------------- docker ----------------------------- */
function dockerApi(urlPath, timeout = 8000) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: config.paths.dockerSocket, path: urlPath, method: 'GET', timeout },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

export async function containers() {
  const list = await dockerApi('/v1.44/containers/json?all=1');
  if (!Array.isArray(list)) return { available: false, items: [], running: 0, stopped: 0, unhealthy: 0 };

  const items = list.map((c) => {
    const status = c.Status || '';
    const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1] || null;
    return {
      name: (c.Names?.[0] || c.Id.slice(0, 12)).replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status,
      health,
      project: c.Labels?.['com.docker.compose.project'] || null,
      service: c.Labels?.['com.docker.compose.service'] || null,
      createdAt: c.Created ? c.Created * 1000 : null,
      ports: (c.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => `${p.IP === '::' ? '' : p.IP || ''}:${p.PublicPort}->${p.PrivatePort}`),
    };
  }).sort((a, b) => (a.project || 'zz').localeCompare(b.project || 'zz') || a.name.localeCompare(b.name));

  return {
    available: true,
    items,
    running: items.filter(i => i.state === 'running').length,
    stopped: items.filter(i => i.state !== 'running').length,
    unhealthy: items.filter(i => i.health === 'unhealthy').length,
  };
}

export async function dockerDisk() {
  const df = await dockerApi('/v1.44/system/df', 20000);
  if (!df) return null;
  const sum = (arr, f) => (arr || []).reduce((a, x) => a + (f(x) || 0), 0);
  return {
    images: { count: (df.Images || []).length, size: sum(df.Images, i => i.Size) },
    containers: { count: (df.Containers || []).length, size: sum(df.Containers, c => c.SizeRw) },
    volumes: { count: (df.Volumes || []).length, size: sum(df.Volumes, v => v.UsageData?.Size) },
    buildCache: { size: sum(df.BuildCache, b => b.Size), reclaimable: sum(df.BuildCache, b => (b.InUse ? 0 : b.Size)) },
  };
}

/* ------------------------------ pm2 ------------------------------ */
export async function pm2() {
  const r = await run('sudo', ['-n', '-H', config.paths.pm2, 'jlist'], { timeout: 10000 });
  if (!r.ok) return { available: false, items: [] };
  const jsonStart = r.stdout.indexOf('[');
  if (jsonStart < 0) return { available: false, items: [] };
  let list;
  try { list = JSON.parse(r.stdout.slice(jsonStart)); } catch { return { available: false, items: [] }; }
  if (!Array.isArray(list)) return { available: false, items: [] };

  const items = list.map((p) => ({
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

/* ---------------------------- systemd ---------------------------- */
export async function systemd() {
  const [failed, nginx, docker, ssh] = await Promise.all([
    run('systemctl', ['--failed', '--no-legend', '--plain', '--no-pager']),
    run('systemctl', ['is-active', 'nginx']),
    run('systemctl', ['is-active', 'docker']),
    run('systemctl', ['is-active', 'ssh']),
  ]);
  const failedUnits = failed.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.split(/\s+/)[0]);
  return {
    failedUnits,
    nginx: nginx.stdout.trim() || 'unknown',
    docker: docker.stdout.trim() || 'unknown',
    ssh: ssh.stdout.trim() || 'unknown',
  };
}

/* --------------------------- filesystem -------------------------- */
export async function filesystems() {
  const r = await run('df', ['-PB1', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs']);
  const rows = r.stdout.split('\n').slice(1).filter(Boolean);
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const f = row.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [device, sizeS, usedS, availS, , mount] = f;
    if (!device.startsWith('/dev/')) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    const size = Number(sizeS); const used = Number(usedS); const avail = Number(availS);
    items.push({ device, mount, size, used, avail, usedPct: size ? (used / size) * 100 : 0 });
  }
  items.sort((a, b) => b.size - a.size);

  const inodes = await run('df', ['-Pi', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay']);
  for (const row of inodes.stdout.split('\n').slice(1)) {
    const f = row.trim().split(/\s+/);
    if (f.length < 6) continue;
    const it = items.find(i => i.mount === f[5]);
    if (it) it.inodePct = parseFloat(f[4]) || 0;
  }
  return items;
}

/* ---------------------------- fail2ban --------------------------- */
export async function fail2ban() {
  const r = await run('sudo', ['-n', config.paths.fail2ban, 'status', 'sshd'], { timeout: 8000 });
  if (!r.ok) return { available: false };
  const num = (re) => Number(re.exec(r.stdout)?.[1] ?? 0);
  return {
    available: true,
    currentlyBanned: num(/Currently banned:\s+(\d+)/),
    totalBanned: num(/Total banned:\s+(\d+)/),
    currentlyFailed: num(/Currently failed:\s+(\d+)/),
    totalFailed: num(/Total failed:\s+(\d+)/),
  };
}

/* --------------------------- ssh log ----------------------------- */
const TAIL_BYTES = 512 * 1024;

export async function sshActivity() {
  try {
    const stat = await fsp.stat(config.paths.authLog);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fh = await fsp.open(config.paths.authLog, 'r');
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    await fh.read(buf, 0, buf.length, start);
    await fh.close();
    const text = buf.toString('utf8');

    const failed = (text.match(/Failed password/g) || []).length;
    const invalid = (text.match(/Invalid user/g) || []).length;
    const accepted = [];
    const re = /^(\S+)\s.*Accepted (\S+) for (\S+) from (\S+)/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      accepted.push({ at: m[1], method: m[2], user: m[3], ip: m[4] });
    }
    const topIps = {};
    const reFail = /Failed password for (?:invalid user )?\S+ from (\S+)/g;
    let f;
    while ((f = reFail.exec(text)) !== null) { topIps[f[1]] = (topIps[f[1]] || 0) + 1; }

    return {
      available: true,
      windowBytes: buf.length,
      failedPassword: failed,
      invalidUser: invalid,
      recentLogins: accepted.slice(-8).reverse(),
      topAttackers: Object.entries(topIps).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([ip, count]) => ({ ip, count })),
    };
  } catch {
    return { available: false };
  }
}

/* ---------------------------- backups ---------------------------- */
export async function backups() {
  const out = [];
  for (const dir of config.backupDirs) {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      let newest = null; let count = 0; let bytes = 0;
      for (const e of entries) {
        if (!e.isFile()) continue;
        const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
        if (!st) continue;
        count += 1; bytes += st.size;
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name: e.name, mtimeMs: st.mtimeMs, size: st.size };
      }
      out.push({
        dir, exists: true, count, bytes,
        newest: newest ? { name: newest.name, at: newest.mtimeMs, size: newest.size } : null,
        ageHours: newest ? (Date.now() - newest.mtimeMs) / 3600000 : null,
      });
    } catch {
      out.push({ dir, exists: false, count: 0, bytes: 0, newest: null, ageHours: null });
    }
  }
  return out;
}

/* ----------------------- nginx server names ---------------------- */
export function nginxDomains() {
  const domains = new Set();
  try {
    for (const f of fs.readdirSync(config.paths.nginxSitesEnabled)) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(config.paths.nginxSitesEnabled, f), 'utf8'); } catch { continue; }
      const re = /^\s*server_name\s+([^;]+);/gm;
      let m;
      while ((m = re.exec(txt)) !== null) {
        for (const d of m[1].trim().split(/\s+/)) {
          if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d) && !d.startsWith('_')) domains.add(d.toLowerCase());
        }
      }
    }
  } catch { /* nginx dir unreadable */ }
  return [...domains].sort();
}

/* ------------------------- os / packages ------------------------- */
export async function osInfo() {
  let pretty = 'Linux';
  try {
    const txt = await fsp.readFile('/etc/os-release', 'utf8');
    pretty = /PRETTY_NAME="?([^"\n]+)"?/.exec(txt)?.[1] || pretty;
  } catch { /* ignore */ }

  const running = (await run('uname', ['-r'])).stdout.trim();
  let installed = running;
  try {
    const files = await fsp.readdir('/boot');
    const kernels = files.filter(f => f.startsWith('vmlinuz-')).map(f => f.replace('vmlinuz-', ''));
    kernels.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    installed = kernels[kernels.length - 1] || running;
  } catch { /* ignore */ }

  let rebootRequired = false;
  try { await fsp.access('/var/run/reboot-required'); rebootRequired = true; } catch { /* ignore */ }

  return { pretty, kernelRunning: running, kernelInstalled: installed, rebootRequired: rebootRequired || installed !== running };
}
