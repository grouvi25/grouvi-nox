import express from 'express';
import { detailLimit } from './limits.js';
import { containerDetail,deployments,filesystemBrowse,pm2Detail } from '../../metrics/services.js';
const router=express.Router();

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

export default router;
