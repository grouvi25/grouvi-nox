import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { config } from '../../config.js';
import { requireSameOrigin, rateLimit, clientIp } from '../../security.js';
import { listCredentials, audit } from '../../auth.js';
import { normalizeProposal, proposalHash, classifyProposal, classifyPath } from '../../changes/policy.js';
import { broker } from '../../changes/client.js';
import { readRegularFile } from '../../changes/fsutil.js';
import { createControlClient } from '../../changes/fleet-link.js';
import { listFleetNodes } from '../../database.js';
import { resolvedDiscovery } from '../../discovery/store.js';
import { buildProjectGraph } from '../../discovery/graph.js';
import { detailLimit } from './limits.js';

/**
 * Dashboard side of agent-proposed changes.
 *
 * This layer lists proposals and shows exactly what they would do. It cannot
 * apply anything on its own authority: every apply and rollback carries the
 * operator's passkey signature, which the root broker verifies itself.
 */

const router = express.Router();
const changeLimit = rateLimit({ windowMs: 60_000, max: 40, name: 'changes' });
const approvalLimit = rateLimit({ windowMs: 10 * 60_000, max: 30, name: 'changes-approval' });
const rejectionsFile = () => path.join(config.stateDir, 'proposal-rejections.json');
const PROPOSAL_FILE = /^p-[0-9]{14}-[0-9a-f]{6}\.json$/;
const PROPOSAL_ID = /^p-[0-9]{14}-[0-9a-f]{6}$/;
const MAX_LISTED = 60;

/* ---------------------------- fleet nodes --------------------------- */

function lookupNode(nodeId) {
  const secret = [config.fleet.nodes[nodeId]].flat().find(s => typeof s === 'string' && s.length >= 32);
  const node = listFleetNodes(config.fleet.offlineAfterMs).find(n => n.id === nodeId);
  return node?.publicUrl && secret ? { url: node.publicUrl, secret } : null;
}

const fleet = createControlClient({ lookup: lookupNode, hubId: config.fleet.nodeId || 'hub' });
const isRemote = node => Boolean(node) && node !== 'local' && node !== config.fleet.nodeId;

/** The same five operations, whether the change runs here or on a node. */
function transportFor(node) {
  if (!isRemote(node)) return { ...broker, apply: broker.apply, rollback: broker.rollback };
  return {
    challenge: payload => fleet.call(node, 'POST', '/v1/challenge', payload),
    apply: payload => fleet.callAndWait(node, '/v1/apply', payload),
    rollback: payload => fleet.callAndWait(node, '/v1/rollback', payload),
    changes: () => fleet.call(node, 'GET', '/v1/changes', undefined, { timeoutMs: 8000 }),
    change: id => fleet.call(node, 'GET', `/v1/changes/${encodeURIComponent(id)}`, undefined, { timeoutMs: 8000 }),
  };
}

/** Local history plus every reachable node, newest first, each row tagged with where it ran. */
async function historyAll() {
  const rows = [];
  try { rows.push(...(await broker.changes(60)).changes.map(c => ({ ...c, host: 'local' }))); } catch { /* broker off */ }
  const nodes = listFleetNodes(config.fleet.offlineAfterMs).filter(n => n.online && isRemote(n.id));
  await Promise.allSettled(nodes.map(async n => {
    const data = await transportFor(n.id).changes();
    rows.push(...(data.changes || []).map(c => ({ ...c, host: n.id })));
  }));
  return rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 80);
}

const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 5 * 60_000).unref();

function readRejections() { try { return JSON.parse(fs.readFileSync(rejectionsFile(), 'utf8')); } catch { return {}; } }
function writeRejections(map) {
  const recent = Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 300));
  fs.writeFileSync(rejectionsFile(), JSON.stringify(recent), { mode: 0o600 });
}

function knownProjectPaths() {
  try { return new Set(buildProjectGraph(resolvedDiscovery()).projects.map(p => p.path).filter(Boolean)); } catch { return new Set(); }
}

function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

function currentContent(target) {
  if (classifyPath(target).length) return { readable: false, sensitive: true };
  let real;
  try { real = fs.realpathSync(target); } catch { return { readable: false, missing: true }; }
  const content = readRegularFile(real, { maxBytes: 200_000, encoding: 'utf8' });
  return content === null ? { readable: false } : { readable: true, content };
}

function proposalFiles() {
  try { return fs.readdirSync(config.changes.proposalsDir).filter(n => PROPOSAL_FILE.test(n)); } catch { return []; }
}

function loadProposal(id) {
  if (!PROPOSAL_ID.test(id)) return null;
  // The agent owns this directory: no links out of it, and no files sized to hurt a parser.
  const text = readRegularFile(path.join(config.changes.proposalsDir, `${id}.json`), { maxBytes: 2_000_000, encoding: 'utf8' });
  if (text === null) return null;
  try {
    const proposal = normalizeProposal(JSON.parse(text));
    return proposal.id === id ? proposal : null;
  } catch { return null; }
}

function present(proposal, { detail = false, known, status = 'pending', change = null } = {}) {
  const verdict = classifyProposal(proposal);
  const reasons = [...verdict.reasons];
  const unknownTarget = proposal.kind === 'patch' && !isRemote(proposal.node) && !(known || knownProjectPaths()).has(proposal.patch.projectPath);
  if (unknownTarget) reasons.push('target is not a discovered project');
  const view = {
    id: proposal.id,
    title: proposal.title,
    why: proposal.why,
    kind: proposal.kind,
    node: proposal.node,
    scope: proposal.scope,
    createdAt: proposal.createdAt,
    hash: proposalHash(proposal),
    tier: reasons.length ? 'dangerous' : 'routine',
    reasons,
    status,
    changeId: change?.changeId || null,
    post: proposal.post,
    undo: proposal.undo || null,
    healthcheck: proposal.healthcheck || null,
    validate: proposal.validate || null,
  };
  if (proposal.kind === 'patch') {
    view.target = proposal.patch.projectPath;
    view.files = proposal.patch.files;
    view.stats = diffStats(proposal.patch.diff);
    if (detail) view.diff = proposal.patch.diff;
  } else if (proposal.kind === 'file') {
    view.target = proposal.file.path;
    if (detail) { view.content = proposal.file.content; view.current = currentContent(proposal.file.path); }
  } else {
    view.target = proposal.command.cwd;
    view.script = proposal.command.script;
    view.timeoutSec = proposal.command.timeoutSec;
  }
  return view;
}

async function changeIndex() {
  try { return new Map((await historyAll()).map(c => [c.proposalId, c])); } catch { return new Map(); }
}

function statusOf(proposalId, rejections, index) {
  const change = index.get(proposalId);
  if (change) return { status: change.status === 'applied' ? 'applied' : change.status === 'rolled_back' ? 'rolled_back' : change.status, change };
  if (rejections[proposalId]) return { status: 'rejected', change: null };
  return { status: 'pending', change: null };
}

async function passkeyOptions(challenge) {
  return generateAuthenticationOptions({
    rpID: config.rpID,
    challenge: Buffer.from(challenge, 'base64url'),
    allowCredentials: listCredentials().map(c => ({ id: c.id, transports: c.transports })),
    userVerification: 'required',
    timeout: 90_000,
  });
}

function fail(res, error) {
  const status = error.status && error.status < 600 ? error.status : 500;
  return res.status(status).json({ error: error.message || 'failed' });
}

function startJob(res, label, run) {
  const id = crypto.randomUUID();
  const job = { id, label, status: 'running', createdAt: Date.now() };
  jobs.set(id, job);
  run().then(result => Object.assign(job, { status: 'done', result, completedAt: Date.now() }))
    .catch(error => Object.assign(job, { status: 'error', error: error.message || 'failed', httpStatus: error.status || 500, completedAt: Date.now() }));
  res.set('Cache-Control', 'no-store');
  return res.status(202).json({ jobId: id, status: 'running' });
}

/* ------------------------------ reads ------------------------------ */

router.get('/changes/status', detailLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const health = await broker.health();
    res.json({ available: true, enabled: health.enabled, busy: health.busy, journalOk: health.journal?.ok !== false, host: health.host });
  } catch { res.json({ available: false, enabled: false }); }
});

router.get('/changes/proposals', detailLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const names = proposalFiles();
  const rejections = readRejections();
  const index = await changeIndex();
  const known = knownProjectPaths();
  const proposals = [];
  for (const name of names.sort().reverse().slice(0, MAX_LISTED)) {
    const proposal = loadProposal(name.slice(0, -5));
    if (!proposal) continue;
    const { status, change } = statusOf(proposal.id, rejections, index);
    proposals.push(present(proposal, { known, status, change }));
  }
  res.json({ proposals, pending: proposals.filter(p => p.status === 'pending').length });
});

router.get('/changes/proposals/:id', detailLimit, async (req, res) => {
  const proposal = loadProposal(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'not_found' });
  const { status, change } = statusOf(proposal.id, readRejections(), await changeIndex());
  res.set('Cache-Control', 'no-store');
  return res.json(present(proposal, { detail: true, status, change }));
});

router.get('/changes/history', detailLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json({ changes: await historyAll() }); } catch (error) { fail(res, error); }
});

router.get('/changes/history/:id', detailLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await transportFor(String(req.query.host || 'local')).change(String(req.params.id))); } catch (error) { fail(res, error); }
});

router.get('/changes/journal', detailLimit, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await broker.journal(100)); } catch (error) { fail(res, error); }
});

router.get('/changes/jobs/:id', detailLimit, (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.set('Cache-Control', 'no-store');
  if (job.status === 'running') return res.status(202).json({ jobId: job.id, status: 'running' });
  if (job.status === 'error') return res.status(job.httpStatus >= 400 && job.httpStatus < 600 ? job.httpStatus : 500).json({ error: job.error });
  return res.json({ status: 'done', result: job.result });
});

/* ----------------------------- decisions --------------------------- */

router.post('/changes/proposals/:id/reject', requireSameOrigin, changeLimit, (req, res) => {
  const proposal = loadProposal(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'not_found' });
  const map = readRejections();
  map[proposal.id] = Date.now();
  writeRejections(map);
  audit('changes.reject', proposal.id, clientIp(req));
  return res.json({ ok: true });
});

/** Step one of an approval: the broker issues a one-time challenge for exactly this proposal. */
router.post('/changes/proposals/:id/challenge', requireSameOrigin, approvalLimit, async (req, res) => {
  const proposal = loadProposal(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'not_found' });
  const hash = proposalHash(proposal);
  if (req.body?.hash && req.body.hash !== hash) return res.status(409).json({ error: 'proposal_changed' });
  try {
    const issued = await transportFor(proposal.node).challenge({ proposal });
    // A node that hashes the proposal differently is not looking at what the operator saw.
    if (issued.hash !== hash) return res.status(502).json({ error: 'node_hash_mismatch' });
    return res.json({ hash, nonce: issued.nonce, expiresAt: issued.expiresAt, tier: present(proposal).tier, reasons: present(proposal).reasons, options: await passkeyOptions(issued.challenge) });
  } catch (error) { return fail(res, error); }
});

/** Step two: the signed approval goes to the broker, which verifies it before running anything. */
router.post('/changes/proposals/:id/apply', requireSameOrigin, approvalLimit, (req, res) => {
  const proposal = loadProposal(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'not_found' });
  if (req.body?.hash !== proposalHash(proposal)) return res.status(409).json({ error: 'proposal_changed' });
  const { nonce, assertion } = req.body || {};
  audit('changes.apply.requested', `${proposal.id} ${proposalHash(proposal).slice(0, 12)}`, clientIp(req));
  return startJob(res, `apply ${proposal.id}`, () => transportFor(proposal.node).apply({ proposal, nonce, assertion }));
});

router.post('/changes/history/:id/challenge', requireSameOrigin, approvalLimit, async (req, res) => {
  try {
    const issued = await transportFor(String(req.body?.host || 'local')).challenge({ purpose: 'rollback', changeId: String(req.params.id) });
    return res.json({ hash: issued.hash, nonce: issued.nonce, expiresAt: issued.expiresAt, options: await passkeyOptions(issued.challenge) });
  } catch (error) { return fail(res, error); }
});

router.post('/changes/history/:id/rollback', requireSameOrigin, approvalLimit, (req, res) => {
  const { nonce, assertion, force, host } = req.body || {};
  const changeId = String(req.params.id);
  audit('changes.rollback.requested', `${host || 'local'} ${changeId}`, clientIp(req));
  return startJob(res, `rollback ${changeId}`, () => transportFor(String(host || 'local')).rollback({ changeId, nonce, assertion, force: Boolean(force) }));
});

export default router;
