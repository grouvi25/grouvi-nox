import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, statePath } from './config.js';

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

function ensureDir() {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
}

export function load() {
  if (state) return state;
  ensureDir();
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    state = DEFAULTS();
  }
  let dirty = false;
  const d = DEFAULTS();
  for (const k of Object.keys(d)) {
    if (state[k] === undefined) { state[k] = d[k]; dirty = true; }
  }
  if (!state.sessionSecret) {
    state.sessionSecret = crypto.randomBytes(48).toString('base64url');
    dirty = true;
  }
  if (dirty) save();
  return state;
}

export function get() {
  return state || load();
}

export function save() {
  ensureDir();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
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
