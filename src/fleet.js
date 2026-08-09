import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { publicSnapshot } from './metrics/index.js';
import { updateState } from './updates.js';
import { ingestFleetSnapshot, listFleetNodes, fleetNodeSnapshot, fleetHistory } from './database.js';
import { requireAuth } from './auth.js';

const nonces = new Map();
let pushTimer = null;
let lastPush = { at: null, ok: false, error: null };

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sign(secret, timestamp, nonce, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

function cleanupNonces() {
  const cutoff = Date.now() - 120_000;
  for (const [key, at] of nonces) if (at < cutoff) nonces.delete(key);
}

function publicNodeSnapshot() {
  const snapshot = publicSnapshot();
  return {
    schema: 1,
    node: {
      id: config.fleet.nodeId,
      name: config.fleet.nodeName,
      publicUrl: config.origin,
      version: updateState().current,
    },
    snapshot: { ...snapshot, update: updateState() },
  };
}

async function push() {
  if (!config.fleet.hubUrl || !config.fleet.secret || !config.fleet.nodeId) return;
  const body = JSON.stringify(publicNodeSnapshot());
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    const response = await fetch(`${config.fleet.hubUrl.replace(/\/$/, '')}/fleet-ingest/v1/snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentinel-Node': config.fleet.nodeId,
        'X-Sentinel-Timestamp': timestamp,
        'X-Sentinel-Nonce': nonce,
        'X-Sentinel-Signature': sign(config.fleet.secret, timestamp, nonce, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`hub HTTP ${response.status}`);
    lastPush = { at: Date.now(), ok: true, error: null };
  } catch (error) {
    lastPush = { at: Date.now(), ok: false, error: error.message };
  }
}

export function fleetPushState() { return { ...lastPush, enabled: Boolean(config.fleet.hubUrl) }; }

export function startFleetPush() {
  if (!config.fleet.hubUrl || !config.fleet.secret || !config.fleet.nodeId) return;
  clearInterval(pushTimer);
  setTimeout(push, 3000).unref();
  pushTimer = setInterval(push, config.fleet.pushIntervalMs);
  pushTimer.unref();
}

export function fleetIngestRouter() {
  const router = express.Router();
  router.post('/v1/snapshot', express.text({ type: 'application/json', limit: '2mb' }), (req, res) => {
    cleanupNonces();
    const nodeId = String(req.get('X-Sentinel-Node') || '');
    const timestamp = String(req.get('X-Sentinel-Timestamp') || '');
    const nonce = String(req.get('X-Sentinel-Nonce') || '');
    const signature = String(req.get('X-Sentinel-Signature') || '');
    const secret = config.fleet.nodes[nodeId];
    if (!secret || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(nodeId)) return res.status(401).json({ error: 'unknown_node' });
    const age = Math.abs(Date.now() - Number(timestamp));
    if (!Number.isFinite(age) || age > 60_000) return res.status(401).json({ error: 'stale_request' });
    const replayKey = `${nodeId}:${nonce}`;
    if (!/^[a-f0-9]{32}$/.test(nonce) || nonces.has(replayKey)) return res.status(409).json({ error: 'replay' });
    if (!safeEqual(signature, sign(secret, timestamp, nonce, req.body))) return res.status(401).json({ error: 'bad_signature' });
    let payload;
    try { payload = JSON.parse(req.body); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (payload?.schema !== 1 || payload?.node?.id !== nodeId || !payload?.snapshot) return res.status(400).json({ error: 'bad_payload' });
    nonces.set(replayKey, Date.now());
    ingestFleetSnapshot(nodeId, payload);
    return res.json({ ok: true, receivedAt: Date.now() });
  });
  return router;
}

export function fleetApiRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/nodes', (req, res) => res.json({
    role: config.fleet.role,
    localNodeId: config.fleet.nodeId,
    offlineAfterMs: config.fleet.offlineAfterMs,
    nodes: listFleetNodes(config.fleet.offlineAfterMs),
    push: fleetPushState(),
  }));
  router.get('/nodes/:id/snapshot', (req, res) => {
    const data = fleetNodeSnapshot(req.params.id);
    if (!data) return res.status(404).json({ error: 'not_found' });
    return res.json(data);
  });
  router.get('/nodes/:id/history', (req, res) => res.json(fleetHistory(req.params.id, String(req.query.range || '24h'))));
  return router;
}
