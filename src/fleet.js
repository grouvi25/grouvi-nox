import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { publicSnapshot } from './metrics/index.js';
import { updateState } from './updates.js';
import { ingestFleetSnapshot, listFleetNodes, fleetNodeSnapshot, fleetHistory } from './database.js';
import { requireAuth } from './auth.js';
import { resolvedDiscovery } from './discovery/store.js';
import { buildProjectGraph } from './discovery/graph.js';

const nonces = new Map();
const ingestBuckets = new Map();
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
  for (const [key, bucket] of ingestBuckets) if (Date.now() > bucket.reset) ingestBuckets.delete(key);
}

function nodeSecrets(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.filter(secret => typeof secret === 'string' && secret.length >= 32).slice(0, 2);
}

function ingestAllowed(nodeId, ip) {
  if (config.fleet.allowedIps.length && !config.fleet.allowedIps.includes(ip)) return false;
  const now = Date.now();
  const key = `${nodeId}:${ip}`;
  let bucket = ingestBuckets.get(key);
  if (!bucket || now > bucket.reset) bucket = { count: 0, reset: now + 60_000 };
  bucket.count += 1;
  ingestBuckets.set(key, bucket);
  return bucket.count <= config.fleet.ingestPerMinute;
}

const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}};
const cleanText=(value,max=160)=>String(value||'').replace(/[\r\n\t]+/g,' ').replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,'[redacted]').slice(0,max);
const maskIp=value=>{const ip=String(value||'');if(ip.includes(':'))return ip.split(':').slice(0,3).join(':')+'::/48';const parts=ip.split('.');return parts.length===4?`${parts[0]}.${parts[1]}.x.x`:''};
function safeFleetContext(){
  const graph=buildProjectGraph(resolvedDiscovery()),filesystem=readJson(path.join(config.stateDir,'filesystem.json'))||{},privileged=readJson(path.join(config.stateDir,'privileged.json'))||{};
  return{
    schema:1,
    projects:{generatedAt:graph.generatedAt,summary:graph.summary,items:graph.projects.slice(0,100).map(project=>({id:project.id,name:cleanText(project.name,100),stack:(project.stack||[]).map(x=>cleanText(x,30)),health:project.health}))},
    filesystem:{at:filesystem.at||null,totals:filesystem.totals||{},types:(filesystem.distribution?.types||[]).slice(0,20).map(item=>({name:cleanText(item.name,40),bytes:Number(item.bytes)||0,files:Number(item.files)||0}))},
    deployments:(privileged.deployments||[]).slice(0,50).map(project=>({project:cleanText(project.project,100),branch:cleanText(project.branch,80),dirty:Boolean(project.dirty),dirtyCount:Number(project.dirtyCount)||0,ahead:Number(project.ahead)||0,behind:Number(project.behind)||0,commits:(project.commits||[]).slice(0,20).map(commit=>({short:cleanText(commit.short,16),at:commit.at,subject:cleanText(commit.subject,180)}))})),
  };
}
export function sanitizeFleetSnapshot(source){
  const snapshot=structuredClone(source);
  snapshot.backups=(snapshot.backups||[]).map((backup,index)=>({...backup,dir:path.posix.basename(String(backup.dir||''))||`backup-${index+1}`,newest:backup.newest?{at:backup.newest.at,size:backup.newest.size}:null}));
  if(snapshot.ssh){snapshot.ssh.recentLogins=(snapshot.ssh.recentLogins||[]).map(login=>({...login,ip:maskIp(login.ip)}));snapshot.ssh.topAttackers=(snapshot.ssh.topAttackers||[]).map(item=>({...item,ip:maskIp(item.ip)}))}
  if(snapshot.containers?.items)snapshot.containers.items=snapshot.containers.items.map(item=>({...item,image:path.posix.basename(String(item.image||''))}));
  return snapshot;
}
function publicNodeSnapshot() {
  const snapshot=sanitizeFleetSnapshot(publicSnapshot());
  return {schema:1,node:{id:config.fleet.nodeId,name:config.fleet.nodeName,publicUrl:config.origin,version:updateState().current},snapshot:{...snapshot,update:updateState()},safe:safeFleetContext()};
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
  router.post('/v1/snapshot', express.text({ type: 'application/json', limit: config.fleet.maxSnapshotBytes }), (req, res) => {
    cleanupNonces();
    const nodeId = String(req.get('X-Sentinel-Node') || '');
    const timestamp = String(req.get('X-Sentinel-Timestamp') || '');
    const nonce = String(req.get('X-Sentinel-Nonce') || '');
    const signature = String(req.get('X-Sentinel-Signature') || '');
    const secrets = nodeSecrets(config.fleet.nodes[nodeId]);
    if (!secrets.length || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(nodeId)) return res.status(401).json({ error: 'unknown_node' });
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    if (!ingestAllowed(nodeId, ip)) return res.status(429).json({ error: 'ingest_limited' });
    const age = Math.abs(Date.now() - Number(timestamp));
    if (!Number.isFinite(age) || age > 60_000) return res.status(401).json({ error: 'stale_request' });
    const replayKey = `${nodeId}:${nonce}`;
    if (!/^[a-f0-9]{32}$/.test(nonce) || nonces.has(replayKey)) return res.status(409).json({ error: 'replay' });
    if (!secrets.some(secret => safeEqual(signature, sign(secret, timestamp, nonce, req.body)))) {
      return res.status(401).json({ error: 'bad_signature' });
    }
    let payload;
    try { payload = JSON.parse(req.body); } catch { return res.status(400).json({ error: 'bad_json' }); }
    if (payload?.schema !== 1 || payload?.node?.id !== nodeId || !payload?.snapshot) return res.status(400).json({ error: 'bad_payload' });
    nonces.set(replayKey, Date.now());
    try {
      ingestFleetSnapshot(nodeId, payload);
      return res.json({ ok: true, receivedAt: Date.now() });
    } catch (error) {
      console.error('[fleet-ingest]', error.message);
      return res.status(400).json({ error: 'invalid_snapshot' });
    }
  });
  return router;
}

export function fleetApiRouter(authMiddleware=requireAuth) {
  const router = express.Router();
  router.use(authMiddleware);
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
