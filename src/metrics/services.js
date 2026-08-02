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

function dockerRaw(urlPath, timeout = 10_000) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: config.paths.dockerSocket, path: urlPath, method: 'GET', timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        if (size < 512_000) { chunks.push(chunk); size += chunk.length; }
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(Buffer.alloc(0)));
    req.on('timeout', () => { req.destroy(); resolve(Buffer.alloc(0)); });
    req.end();
  });
}

function decodeDockerLogs(buffer) {
  // Docker multiplexed stream: 8-byte header followed by payload. TTY logs are plain text.
  if (!buffer.length) return '';
  const out = [];
  let offset = 0;
  while (offset + 8 <= buffer.length && buffer[offset] <= 2) {
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 0 || offset + 8 + length > buffer.length) break;
    out.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  const text = (out.length ? Buffer.concat(out) : buffer).toString('utf8');
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(password|passwd|secret|token|api[_-]?key|authorization)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .split('\n').slice(-160).join('\n').slice(-40_000);
}

export async function containerDetail(name) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return null;
  const encoded = encodeURIComponent(name);
  const [inspect, stats, logsBuffer] = await Promise.all([
    dockerApi(`/v1.44/containers/${encoded}/json`),
    dockerApi(`/v1.44/containers/${encoded}/stats?stream=false`, 12_000),
    dockerRaw(`/v1.44/containers/${encoded}/logs?stdout=true&stderr=true&timestamps=true&tail=160`, 12_000),
  ]);
  if (!inspect) return null;
  const cpuDelta = Number(stats?.cpu_stats?.cpu_usage?.total_usage || 0) - Number(stats?.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = Number(stats?.cpu_stats?.system_cpu_usage || 0) - Number(stats?.precpu_stats?.system_cpu_usage || 0);
  const cpuCount = Number(stats?.cpu_stats?.online_cpus || 1);
  const cpuPct = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
  const memory = Number(stats?.memory_stats?.usage || 0);
  const memoryLimit = Number(stats?.memory_stats?.limit || 0);
  return {
    name: String(inspect.Name || '').replace(/^\//, ''),
    id: String(inspect.Id || '').slice(0, 12),
    image: inspect.Config?.Image || '',
    state: inspect.State || {},
    created: inspect.Created,
    platform: inspect.Platform,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    readonlyRootfs: Boolean(inspect.HostConfig?.ReadonlyRootfs),
    privileged: Boolean(inspect.HostConfig?.Privileged),
    networkMode: inspect.HostConfig?.NetworkMode || '',
    project: inspect.Config?.Labels?.['com.docker.compose.project'] || null,
    service: inspect.Config?.Labels?.['com.docker.compose.service'] || null,
    mounts: (inspect.Mounts || []).map(m => ({ destination: m.Destination, type: m.Type, rw: m.RW })),
    ports: inspect.NetworkSettings?.Ports || {},
    cpuPct: Number(cpuPct.toFixed(2)),
    memory,
    memoryLimit,
    memoryPct: memoryLimit ? Number((memory / memoryLimit * 100).toFixed(2)) : 0,
    pids: Number(stats?.pids_stats?.current || 0),
    network: stats?.networks || {},
    logs: decodeDockerLogs(logsBuffer),
  };
}

/* ------------------- privileged side-car snapshot ------------------ *
 * pm2 and fail2ban need root. Instead of granting the web process any
 * escalation path, a separate root service writes this file every 15 s.
 * ------------------------------------------------------------------- */
const PRIV_FILE = `${config.stateDir}/privileged.json`;
const PRIV_MAX_AGE_MS = 90_000;

export async function privileged() {
  try {
    const raw = await fsp.readFile(PRIV_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data?.at || Date.now() - data.at > PRIV_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export async function pm2() {
  const p = await privileged();
  return p?.pm2 || { available: false, items: [] };
}

export async function deployments() {
  const p = await privileged();
  return p?.deployments || [];
}

export async function pm2Detail(name) {
  if (!/^[A-Za-z0-9_.:@-]{1,100}$/.test(name)) return null;
  const p = await pm2();
  return p.items?.find(item => item.name === name) || null;
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
  const p = await privileged();
  return p?.fail2ban || { available: false };
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
