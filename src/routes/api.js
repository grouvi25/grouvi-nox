import express from 'express';
import { requireAuth } from '../auth.js';
import { publicSnapshot } from '../metrics/index.js';
import { get } from '../store.js';
import { config } from '../config.js';

const router = express.Router();

router.use(requireAuth);

router.get('/snapshot', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicSnapshot());
});

router.get('/session', (req, res) => {
  const st = get();
  const s = st.sessions[req.session.sid];
  res.json({
    sid: `${req.session.sid.slice(0, 8)}…`,
    createdAt: s?.createdAt,
    expiresAt: new Date(req.session.exp).toISOString(),
    ip: s?.ip,
    activeSessions: Object.keys(st.sessions).length,
    rpID: config.rpID,
  });
});

router.get('/audit', (req, res) => {
  res.json({ events: get().auditLog.slice(0, 40) });
});

export default router;
