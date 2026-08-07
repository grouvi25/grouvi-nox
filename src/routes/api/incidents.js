import express from 'express';
import { requireSameOrigin } from '../../security.js';
import { actionLimit } from './limits.js';
import { acknowledgeIncident,incidentCounts,listIncidents,resolveIncident,setIncidentStatus,getIncident } from '../../database.js';
import { investigateIncident } from '../../investigator.js';
const router=express.Router();

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

export default router;
