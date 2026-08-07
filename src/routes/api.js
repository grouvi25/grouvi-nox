import crypto from 'node:crypto';
import express from 'express';
import { requireAuth } from '../auth.js';
import { requireSameOrigin, rateLimit } from '../security.js';
import { publicSnapshot } from '../metrics/index.js';
import { containerDetail, deployments, filesystemBrowse, pm2Detail } from '../metrics/services.js';
import {
  acknowledgeIncident, getHistory, incidentCounts, listIncidents, notificationStatus, resolveIncident, setIncidentStatus, updateNotificationSettings,
} from '../database.js';
import { sendTelegramText, telegramState } from '../notifier.js';
import { callAgent } from '../agent-client.js';
import { investigateIncident } from '../investigator.js';
import { getIncident } from '../database.js';
import { get } from '../store.js';
import { config } from '../config.js';

const router = express.Router();
const detailLimit = rateLimit({ windowMs: 60_000, max: 60, name: 'detail' });
const actionLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'incident-action' });
const agentLimit = rateLimit({ windowMs: 10 * 60_000, max: 12, name: 'agent-chat' });

router.use(requireAuth);

router.get('/snapshot', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicSnapshot());
});

router.get('/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getHistory(String(req.query.range || '24h')));
});

router.get('/incidents', (req, res) => {
  const allowed = new Set(['active', 'all', 'open', 'acknowledged', 'resolved']);
  const status = allowed.has(String(req.query.status)) ? String(req.query.status) : 'active';
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 6));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const counts = incidentCounts();
  const total = status === 'all' ? counts.total : status === 'active' ? counts.active : counts[status];
  res.set('Cache-Control', 'no-store');
  res.json({ incidents: listIncidents({ status, limit, offset }), counts, pagination: { total, limit, offset } });
});

router.post('/incidents/:id/status', requireSameOrigin, actionLimit, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad_id' });
  if (!['open','acknowledged','resolved'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const incident = setIncidentStatus(id, status, 'passkey-admin', String(req.body?.note || ''));
  if (!incident) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true, incident });
});

router.post('/incidents/:id/ack', requireSameOrigin, actionLimit, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad_id' });
  const incident = acknowledgeIncident(id, 'passkey-admin', String(req.body?.note || ''));
  if (!incident) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true, incident });
});

router.post('/incidents/:id/resolve', requireSameOrigin, actionLimit, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'bad_id' });
  const incident = resolveIncident(id, 'passkey-admin', String(req.body?.note || 'Closed manually'));
  if (!incident) return res.status(404).json({ error: 'not_found' });
  return res.json({ ok: true, incident });
});

router.post('/incidents/:id/investigate', requireSameOrigin, actionLimit, async (req, res, next) => {
  try {
    const incident = getIncident(Number(req.params.id));
    if (!incident) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, incident: await investigateIncident(incident) });
  } catch (e) { return next(e); }
});

router.get('/agent/projects', async (req, res) => {
  const projects = [{ id: 'vps', name: 'Весь VPS', detail: 'Система и все сервисы', path: '/var/lib/sentinel-ai/workspace' }];
  const known = [
    { id: 'vps-sentinel', name: 'VPS Sentinel', detail: 'grouvi25/vps-sentinel' },
    { id: 'browser-mmo-90s', name: 'MMO90', detail: 'grouvi25/browser-mmo-90s' },
  ];
  const fs = await import('node:fs');
  for (const item of known) {
    const path = `/var/lib/sentinel-ai/workspace/repos/${item.id}`;
    if (fs.existsSync(`${path}/.git`)) projects.push({ ...item, path });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ projects });
});

const agentJobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of agentJobs) if (job.createdAt < cutoff) agentJobs.delete(id);
}, 5 * 60_000).unref();

router.post('/agent/chat', requireSameOrigin, agentLimit, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'bad_messages' });
  const allowedModels = new Set(['DeepSeek-V4-Pro', 'Qwen3.6-35B-A3B']);
  const allowedScopes = new Set(['vps', 'vps-sentinel', 'browser-mmo-90s']);
  const model = allowedModels.has(String(req.body?.model)) ? String(req.body.model) : 'Qwen3.6-35B-A3B';
  const scope = allowedScopes.has(String(req.body?.scope)) ? String(req.body.scope) : 'vps';
  const id = crypto.randomUUID();
  const job = { id, status: 'running', createdAt: Date.now(), model, scope };
  agentJobs.set(id, job);
  callAgent(messages, { model, scope }).then((answer) => {
    Object.assign(job, { status: 'done', answer, completedAt: Date.now() });
  }).catch((e) => {
    Object.assign(job, { status: 'error', error: e.status === 409 ? 'agent_busy' : e.message === 'agent_timeout' ? 'agent_timeout' : 'agent_failed', completedAt: Date.now() });
  });
  res.set('Cache-Control', 'no-store');
  return res.status(202).json({ jobId: id, status: 'running', model, scope });
});

router.get('/agent/chat/:jobId', detailLimit, (req, res) => {
  const job = agentJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.set('Cache-Control', 'no-store');
  if (job.status === 'running') return res.status(202).json({ jobId: job.id, status: 'running' });
  if (job.status === 'error') return res.status(job.error === 'agent_busy' ? 409 : job.error === 'agent_timeout' ? 504 : 502).json({ error: job.error });
  return res.json({ answer: job.answer, model: job.model, scope: job.scope, status: 'done' });
});

router.get('/services/container/:name', detailLimit, async (req, res, next) => {
  try {
    const detail = await containerDetail(req.params.name);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    return res.json({ type: 'container', detail });
  } catch (e) { return next(e); }
});

router.get('/services/pm2/:name', detailLimit, async (req, res, next) => {
  try {
    const detail = await pm2Detail(req.params.name);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    return res.json({ type: 'pm2', detail });
  } catch (e) { return next(e); }
});

router.get('/deployments', async (req, res, next) => {
  try { return res.json({ projects: await deployments() }); }
  catch (e) { return next(e); }
});

router.get('/filesystem', detailLimit, async (req, res, next) => {
  try {
    const result = await filesystemBrowse(String(req.query.path || '/'), String(req.query.q || ''));
    if (!result) return res.status(503).json({ error: 'filesystem_index_unavailable' });
    return res.json(result);
  } catch (e) { return next(e); }
});

router.get('/notifications',(req,res)=>{res.set('Cache-Control','no-store');res.json({telegram:telegramState(),recent:notificationStatus()})});
router.post('/notifications/settings',requireSameOrigin,actionLimit,(req,res)=>{const settings=updateNotificationSettings(req.body||{});res.json({ok:true,telegram:telegramState(),settings})});
router.post('/notifications/test',requireSameOrigin,actionLimit,async(req,res)=>{const result=await sendTelegramText('🛡️ <b>VPS Sentinel</b>\nТест уведомлений прошёл успешно.',{eventType:'test'});res.status(result.sent?200:503).json(result)});

router.get('/session', (req, res) => {
  const st = get();
  const s = st.sessions[req.session.sid];
  res.json({
    sid: `${req.session.sid.slice(0, 8)}…`, createdAt: s?.createdAt,
    expiresAt: new Date(req.session.exp).toISOString(), ip: s?.ip,
    activeSessions: Object.keys(st.sessions).length, rpID: config.rpID,
  });
});

router.get('/audit', (req, res) => res.json({ events: get().auditLog.slice(0, 40) }));

export default router;
