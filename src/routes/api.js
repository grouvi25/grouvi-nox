import express from 'express';
import { requireAuth } from '../auth.js';
import { requireSameOrigin, rateLimit } from '../security.js';
import { publicSnapshot } from '../metrics/index.js';
import { containerDetail, deployments, filesystemBrowse, pm2Detail } from '../metrics/services.js';
import {
  acknowledgeIncident, getHistory, listIncidents, notificationStatus, resolveIncident,
} from '../database.js';
import { telegramState } from '../notifier.js';
import { get } from '../store.js';
import { config } from '../config.js';

const router = express.Router();
const detailLimit = rateLimit({ windowMs: 60_000, max: 60, name: 'detail' });
const actionLimit = rateLimit({ windowMs: 60_000, max: 20, name: 'incident-action' });

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
  const allowed = new Set(['all', 'open', 'acknowledged', 'resolved']);
  const status = allowed.has(String(req.query.status)) ? String(req.query.status) : 'all';
  res.json({ incidents: listIncidents({ status, limit: req.query.limit }) });
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

router.get('/notifications', (req, res) => {
  res.json({ telegram: telegramState(), recent: notificationStatus() });
});

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
