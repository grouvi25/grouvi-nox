import crypto from 'node:crypto';
import { config } from './config.js';

const wsOrigin = config.origin.replace(/^https:/, 'wss:');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${wsOrigin}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "manifest-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy',
    'accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(), display-capture=(), ' +
    'encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), ' +
    'microphone=(), midi=(), payment=(), usb=(), xr-spatial-tracking=()');
  res.removeHeader('X-Powered-By');
  next();
}

/** Reject cross-site requests to state-changing endpoints. */
export function requireSameOrigin(req, res, next) {
  const o = req.get('origin');
  if (o && o !== config.origin) return res.status(403).json({ error: 'bad_origin' });
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'cross_site' });
  }
  next();
}

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

export function rateLimit({ windowMs, max, name = 'rl' }) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function sha256(v) {
  return crypto.createHash('sha256').update(v).digest('base64url');
}

export function scryptHash(secret, salt) {
  return crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url');
}

export function clientIp(req) {
  return (req.ip || '').replace(/^::ffff:/, '');
}
