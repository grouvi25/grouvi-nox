import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';

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
  if (!p?.pm2) return { available: false, items: [] };
  // Realtime snapshots must stay tiny. Log tails and paths are served only by
  // the authenticated drill-down endpoint, never pushed every two seconds.
  return {
    ...p.pm2,
    items: (p.pm2.items || []).map(({ outLog, errorLog, cwd, script, ...item }) => item),
  };
}

export async function deployments() {
  const p = await privileged();
  return p?.deployments || [];
}

export async function pm2Detail(name) {
  if (!/^[A-Za-z0-9_.:@-]{1,100}$/.test(name)) return null;
  const p = await privileged();
  return p?.pm2?.items?.find(item => item.name === name) || null;
}

const FS_INDEX_FILE = `${config.stateDir}/filesystem.json`;
let fsIndexCache = null;
let fsIndexMtime = 0;

async function filesystemIndex() {
  try {
    const stat = await fsp.stat(FS_INDEX_FILE);
    if (!fsIndexCache || stat.mtimeMs !== fsIndexMtime) {
      fsIndexCache = JSON.parse(await fsp.readFile(FS_INDEX_FILE, 'utf8'));
      fsIndexMtime = stat.mtimeMs;
    }
    return fsIndexCache;
  } catch { return null; }
}

export async function filesystemBrowse(requestPath = '/', query = '') {
  const index = await filesystemIndex();
  if (!index) return null;
  const clean = path.posix.normalize(`/${String(requestPath || '/').replace(/^\/+/, '')}`);
  if (!clean.startsWith('/')) return null;
  const q = String(query || '').trim().toLowerCase().slice(0, 100);
  const entries = index.entries || [];
  let children;
  if (q) {
    children = entries.filter(item => item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)).slice(0, 300);
  } else if (clean === '/') {
    children = entries.filter(item => item.parent === '/');
  } else {
    children = entries.filter(item => item.parent === clean);
  }
  children.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });
  const current = clean === '/' ? { path: '/', name: '/', type: 'directory', parent: null } : entries.find(item => item.path === clean);
  return {
    at: index.at, current: current || null, path: clean, query: q,
    children, totals: index.totals, roots: index.roots,
    // Heavy overview lists are sent once at root, not on every folder click.
    largest: clean === '/' && !q ? index.largest || [] : [],
    risks: clean === '/' && !q ? index.risks || [] : [],
    policy: index.policy,
  };
}
