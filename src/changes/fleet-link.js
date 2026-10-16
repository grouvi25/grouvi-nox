import crypto from 'node:crypto';
import express from 'express';

/**
 * Hub → node control channel.
 *
 * The signature here only proves the request came from the hub. It does not
 * authorise anything: the node's own broker still demands the operator's
 * passkey signature, verified against approvers imported by root. A stolen
 * fleet secret therefore buys an attacker the ability to ask, not to run.
 *
 * Disabled until the node lists the hub's address in FLEET_CONTROL_ALLOWED_IPS.
 */

const SKEW_MS = 60_000;
const MAX_BODY = 1_500_000;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const mac = (secret, parts) => crypto.createHmac('sha256', secret).update(parts.join('\n')).digest('hex');

export function controlHeaders(secret, hubId, method, route, body) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    'X-Sentinel-Hub': hubId,
    'X-Sentinel-Timestamp': timestamp,
    'X-Sentinel-Nonce': nonce,
    'X-Sentinel-Signature': mac(secret, [timestamp, nonce, method, route, sha256(body)]),
  };
}

function equalHex(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Hub side: signed calls to a node. `lookup(nodeId)` returns { url, secret } or null. */
export function createControlClient({ lookup, hubId, fetchImpl = fetch }) {
  async function call(nodeId, method, route, payload, { timeoutMs = 25_000 } = {}) {
    const target = lookup(nodeId);
    if (!target?.url || !target.secret) throw Object.assign(new Error('node_unknown'), { status: 404 });
    const body = payload === undefined ? '' : JSON.stringify(payload);
    let response;
    try {
      response = await fetchImpl(`${target.url.replace(/\/$/, '')}/fleet-control${route}`, {
        method,
        headers: { 'content-type': 'application/json', ...controlHeaders(target.secret, hubId, method, `/fleet-control${route}`, body) },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw Object.assign(new Error('node_unreachable'), { status: 502 });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `node_http_${response.status}`), { status: response.status });
    return data;
  }

  /** Runs a long operation on the node (it answers with a job id) and waits for it. */
  async function callAndWait(nodeId, route, payload, { pollMs = 1500, maxMs = 20 * 60_000 } = {}) {
    const started = await call(nodeId, 'POST', route, payload);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      let job;
      try { job = await call(nodeId, 'GET', `/v1/jobs/${encodeURIComponent(started.jobId)}`); } catch (error) {
        if (error.status === 202) continue;
        throw error;
      }
      if (job.status === 'running') continue;
      return job.result;
    }
    throw Object.assign(new Error('node_timeout'), { status: 504 });
  }

  return { call, callAndWait };
}

/** Node side. `brokerApi` is the local broker client; `secrets()` and `allowedIps()` read live config. */
export function createControlRouter({ brokerApi, secrets, allowedIps, now = Date.now }) {
  const router = express.Router();
  const seen = new Map();
  const jobs = new Map();
  const hits = new Map();

  const sweep = () => {
    const cutoff = now() - 2 * SKEW_MS;
    for (const [key, at] of seen) if (at < cutoff) seen.delete(key);
    for (const [id, job] of jobs) if (job.createdAt < now() - 60 * 60_000) jobs.delete(id);
  };

  router.use(express.text({ type: 'application/json', limit: MAX_BODY }));
  router.use((req, res, next) => {
    sweep();
    const ips = allowedIps();
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!ips.length) return res.status(403).json({ error: 'fleet_control_disabled' });
    if (!ips.includes(ip)) return res.status(403).json({ error: 'forbidden' });
    const bucket = hits.get(ip) || { count: 0, reset: now() + 60_000 };
    if (now() > bucket.reset) { bucket.count = 0; bucket.reset = now() + 60_000; }
    bucket.count += 1;
    hits.set(ip, bucket);
    if (bucket.count > 120) return res.status(429).json({ error: 'rate_limited' });

    const body = typeof req.body === 'string' ? req.body : '';
    const timestamp = String(req.get('X-Sentinel-Timestamp') || '');
    const nonce = String(req.get('X-Sentinel-Nonce') || '');
    const signature = String(req.get('X-Sentinel-Signature') || '');
    if (!Number.isFinite(Number(timestamp)) || Math.abs(now() - Number(timestamp)) > SKEW_MS) return res.status(401).json({ error: 'stale_request' });
    if (!/^[a-f0-9]{32}$/.test(nonce) || seen.has(nonce)) return res.status(409).json({ error: 'replay' });
    const route = `/fleet-control${req.path}`;
    const valid = secrets().some(secret => equalHex(signature, mac(secret, [timestamp, nonce, req.method, route, sha256(body)])));
    if (!valid) return res.status(401).json({ error: 'bad_signature' });
    seen.set(nonce, now());
    try { req.payload = body ? JSON.parse(body) : {}; } catch { return res.status(400).json({ error: 'bad_json' }); }
    return next();
  });

  const relay = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (error) { res.status(error.status && error.status < 600 ? error.status : 502).json({ error: error.message || 'failed' }); }
  };
  const startJob = (req, res, run) => {
    const id = crypto.randomUUID();
    const job = { id, status: 'running', createdAt: now() };
    jobs.set(id, job);
    run().then(result => Object.assign(job, { status: 'done', result })).catch(error => Object.assign(job, { status: 'error', error: error.message, httpStatus: error.status || 500 }));
    res.status(202).json({ jobId: id, status: 'running' });
  };

  router.get('/v1/health', relay(() => brokerApi.health()));
  router.get('/v1/changes', relay(() => brokerApi.changes(50)));
  router.get('/v1/changes/:id', relay(req => brokerApi.change(String(req.params.id))));
  router.post('/v1/challenge', relay(req => brokerApi.challenge(req.payload)));
  router.post('/v1/probe', relay(req => brokerApi.probe(req.payload)));
  router.post('/v1/apply', (req, res) => startJob(req, res, () => brokerApi.apply(req.payload)));
  router.post('/v1/rollback', (req, res) => startJob(req, res, () => brokerApi.rollback(req.payload)));
  router.get('/v1/jobs/:id', (req, res) => {
    const job = jobs.get(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    if (job.status === 'running') return res.status(202).json({ status: 'running' });
    if (job.status === 'error') return res.status(job.httpStatus >= 400 && job.httpStatus < 600 ? job.httpStatus : 500).json({ error: job.error });
    return res.json({ status: 'done', result: job.result });
  });
  return router;
}
