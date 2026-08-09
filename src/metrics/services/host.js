import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';
import { run } from './command.js';
import { privileged } from './privileged.js';
import {enabledNames,selectedPaths} from '../../discovery/store.js';

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
  const selected=enabledNames('service','systemd');
  const monitored={};
  if(selected)for(const unit of selected){const state=await run('systemctl',['is-active',unit]);monitored[unit]=state.stdout.trim()||'unknown'}
  return{failedUnits,nginx:nginx.stdout.trim()||'unknown',docker:docker.stdout.trim()||'unknown',ssh:ssh.stdout.trim()||'unknown',monitored};
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
  const posture=(await privileged())?.security||null;
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
      posture,
    };
  } catch {
    return { available: false,posture };
  }
}

export async function databases(){const out=[];for(const file of selectedPaths('database')){try{const stat=await fsp.stat(file);out.push({path:file,name:path.basename(file),exists:true,bytes:stat.size,mtime:stat.mtimeMs})}catch{out.push({path:file,name:path.basename(file),exists:false,bytes:0,mtime:null})}}return out}

/* ---------------------------- backups ---------------------------- */
export async function backups() {
  const out = [];
  const dirs=[...new Set([...config.backupDirs,...selectedPaths('backup')])];
  for(const dir of dirs){
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
