import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, statePath } from './config.js';

/**
 * State is shared between two processes: the long-running web service and the
 * short-lived CLI (`npm run enroll` / `recovery`). Without coordination the
 * service would happily overwrite whatever the CLI just wrote, because it holds
 * its own copy in memory. So every read checks the file mtime and reloads when
 * somebody else touched it.
 */

const DEFAULTS = () => ({
  version: 1,
  createdAt: new Date().toISOString(),
  sessionSecret: null,
  credentials: [],   // { id, publicKey(b64u), counter, transports[], label, createdAt, lastUsedAt, deviceType, backedUp }
  enrollTokens: [],  // { id, hash, expiresAt, usedAt, note }
  recoveryCodes: [], // { hash, salt, usedAt }
  sessions: {},      // sid -> { createdAt, lastSeenAt, ip, ua, revoked }
  auditLog: [],      // { at, event, detail, ip }
});

let state = null;
let knownMtimeMs = 0;
let lastCheckedAt = 0;
const CHECK_THROTTLE_MS = 250;

function ensureDir() {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
}

function currentMtime() {
  try { return fs.statSync(statePath).mtimeMs; } catch { return 0; }
}

function readFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    knownMtimeMs = currentMtime();
    return parsed;
  } catch {
    return null;
  }
}

function normalise(obj) {
  const d = DEFAULTS();
  let dirty = false;
  for (const k of Object.keys(d)) {
    if (obj[k] === undefined) { obj[k] = d[k]; dirty = true; }
  }
  if (!obj.sessionSecret) {
    obj.sessionSecret = crypto.randomBytes(48).toString('base64url');
    dirty = true;
  }
  return dirty;
}

export function load() {
  if (state) return state;
  ensureDir();
  state = readFromDisk() || DEFAULTS();
  if (normalise(state)) save();
  return state;
}

/** Reload if another process wrote the file since we last looked. */
function ensureFresh() {
  const now = Date.now();
  if (now - lastCheckedAt < CHECK_THROTTLE_MS) return;
  lastCheckedAt = now;

  const mtime = currentMtime();
  if (mtime === 0 || mtime === knownMtimeMs) return;

  const fresh = readFromDisk();
  if (!fresh) return;

  // Keep the session secret stable: rotating it would sign out every browser.
  if (!fresh.sessionSecret && state?.sessionSecret) fresh.sessionSecret = state.sessionSecret;
  state = fresh;
  normalise(state);
}

export function get() {
  if (!state) return load();
  ensureFresh();
  return state;
}

export function save() {
  ensureDir();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
  knownMtimeMs = currentMtime();
  lastCheckedAt = Date.now();
}

export function audit(event, detail, ip) {
  const st = get();
  st.auditLog.unshift({ at: new Date().toISOString(), event, detail: detail || '', ip: ip || '' });
  if (st.auditLog.length > 300) st.auditLog.length = 300;
  save();
}

/** Drop expired sessions / enrollment tokens. */
export function prune() {
  const st = get();
  const now = Date.now();
  let dirty = false;

  for (const [sid, s] of Object.entries(st.sessions)) {
    const age = now - new Date(s.createdAt).getTime();
    if (s.revoked || age > config.sessionTtlMs) { delete st.sessions[sid]; dirty = true; }
  }
  const before = st.enrollTokens.length;
  st.enrollTokens = st.enrollTokens.filter(t => !t.usedAt && t.expiresAt > now);
  if (st.enrollTokens.length !== before) dirty = true;

  if (dirty) save();
}
