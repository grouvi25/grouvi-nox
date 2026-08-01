import crypto from 'node:crypto';
import * as cookie from 'cookie';
import { config } from './config.js';
import { get, save, audit } from './store.js';
import { sha256, scryptHash, safeEqual } from './security.js';

export const SESSION_COOKIE = '__Host-vps_session';
export const CHALLENGE_COOKIE = '__Host-vps_chal';

/* ------------------------------------------------------------------ *
 * Challenge cache (in memory, short lived)                            *
 * ------------------------------------------------------------------ */
const challenges = new Map(); // chid -> { challenge, kind, expiresAt, tokenId }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (now > v.expiresAt) challenges.delete(k);
}, 30_000).unref();

export function putChallenge(kind, challenge, extra = {}) {
  const chid = crypto.randomBytes(24).toString('base64url');
  challenges.set(chid, { challenge, kind, expiresAt: Date.now() + config.challengeTtlMs, ...extra });
  return chid;
}

export function takeChallenge(chid, kind) {
  if (!chid) return null;
  const c = challenges.get(chid);
  if (!c) return null;
  challenges.delete(chid);
  if (c.kind !== kind || Date.now() > c.expiresAt) return null;
  return c;
}

export function setChallengeCookie(res, chid) {
  res.append('Set-Cookie', cookie.serialize(CHALLENGE_COOKIE, chid, {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/',
    maxAge: Math.floor(config.challengeTtlMs / 1000),
  }));
}

export function clearChallengeCookie(res) {
  res.append('Set-Cookie', cookie.serialize(CHALLENGE_COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0,
  }));
}

export function readCookies(req) {
  try { return cookie.parse(req.headers.cookie || ''); } catch { return {}; }
}

/* ------------------------------------------------------------------ *
 * Sessions: HMAC-signed token, server-side revocation list            *
 * ------------------------------------------------------------------ */
function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', get().sessionSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', get().sessionSecret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload?.sid || !payload?.exp || Date.now() > payload.exp) return null;

  const sess = get().sessions[payload.sid];
  if (!sess || sess.revoked) return null;
  return { ...payload, session: sess };
}

export function createSession(res, { ip, ua, credentialId }) {
  const st = get();
  const sid = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  st.sessions[sid] = {
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    ip: ip || '',
    ua: (ua || '').slice(0, 160),
    credentialId: credentialId || null,
    revoked: false,
  };
  save();

  const token = signPayload({ sid, iat: now, exp: now + config.sessionTtlMs });
  res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  }));
  return sid;
}

export function destroySession(req, res) {
  const token = readCookies(req)[SESSION_COOKIE];
  const payload = verifySessionToken(token);
  if (payload) {
    const st = get();
    delete st.sessions[payload.sid];
    save();
  }
  res.append('Set-Cookie', cookie.serialize(SESSION_COOKIE, '', {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0,
  }));
}

export function currentSession(req) {
  return verifySessionToken(readCookies(req)[SESSION_COOKIE]);
}

export function requireAuth(req, res, next) {
  const s = currentSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.session = s;
  const st = get();
  const rec = st.sessions[s.sid];
  if (rec) {
    const last = new Date(rec.lastSeenAt).getTime();
    if (Date.now() - last > 60_000) { rec.lastSeenAt = new Date().toISOString(); save(); }
  }
  next();
}

/* ------------------------------------------------------------------ *
 * Enrollment tokens                                                    *
 * ------------------------------------------------------------------ */
export function createEnrollToken(note = '') {
  const st = get();
  const raw = crypto.randomBytes(32).toString('base64url');
  st.enrollTokens.push({
    id: crypto.randomBytes(8).toString('hex'),
    hash: sha256(raw),
    expiresAt: Date.now() + config.enrollTokenTtlMs,
    usedAt: null,
    note,
  });
  save();
  return raw;
}

export function findEnrollToken(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const h = sha256(raw);
  const st = get();
  const now = Date.now();
  return st.enrollTokens.find(t => !t.usedAt && t.expiresAt > now && safeEqual(t.hash, h)) || null;
}

export function consumeEnrollToken(tokenRecord) {
  tokenRecord.usedAt = Date.now();
  save();
}

/* ------------------------------------------------------------------ *
 * Recovery codes                                                       *
 * ------------------------------------------------------------------ */
export function generateRecoveryCodes(count = 10) {
  const st = get();
  const plain = [];
  st.recoveryCodes = [];
  for (let i = 0; i < count; i += 1) {
    const code = crypto.randomBytes(10).toString('base64url').replace(/[-_]/g, '').slice(0, 12).toUpperCase();
    const pretty = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
    const salt = crypto.randomBytes(16).toString('base64url');
    st.recoveryCodes.push({ hash: scryptHash(pretty, salt), salt, usedAt: null });
    plain.push(pretty);
  }
  save();
  return plain;
}

export function useRecoveryCode(input) {
  if (!input || typeof input !== 'string' || input.length > 32) return false;
  const code = input.trim().toUpperCase();
  const st = get();
  for (const rc of st.recoveryCodes) {
    if (rc.usedAt) continue;
    if (safeEqual(rc.hash, scryptHash(code, rc.salt))) {
      rc.usedAt = Date.now();
      save();
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Credentials                                                          *
 * ------------------------------------------------------------------ */
export function listCredentials() {
  return get().credentials;
}

export function addCredential(cred) {
  const st = get();
  st.credentials.push(cred);
  save();
}

export function touchCredential(id, counter) {
  const st = get();
  const c = st.credentials.find(x => x.id === id);
  if (c) {
    c.counter = counter;
    c.lastUsedAt = new Date().toISOString();
    save();
  }
}

export { audit };
