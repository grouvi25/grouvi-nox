import express from 'express';
import { detailLimit } from './limits.js';
import { containerDetail,deployments,filesystemBrowse,pm2Detail,systemdDetail } from '../../metrics/services.js';
import { resolvedDiscovery } from '../../discovery/store.js';
import { findProject } from '../../discovery/graph.js';
const router=express.Router();

const detailFor=async component=>{
  if(component.adapter==='container')return containerDetail(component.name);
  if(component.adapter==='pm2')return pm2Detail(component.name);
  if(component.adapter==='systemd')return systemdDetail(component.name);
  return null;
};

router.get('/services/container/:name', detailLimit, async (req, res, next) => {
  try { const detail=await containerDetail(req.params.name);if(!detail)return res.status(404).json({error:'not_found'});return res.json({type:'container',detail}); }
  catch(e){return next(e)}
});
router.get('/services/pm2/:name', detailLimit, async (req, res, next) => {
  try { const detail=await pm2Detail(req.params.name);if(!detail)return res.status(404).json({error:'not_found'});return res.json({type:'pm2',detail}); }
  catch(e){return next(e)}
});
router.get('/services/systemd/:name', detailLimit, async (req, res, next) => {
  try { const detail=await systemdDetail(req.params.name);if(!detail)return res.status(404).json({error:'not_found'});return res.json({type:'systemd',detail}); }
  catch(e){return next(e)}
});
router.get('/projects/:id', detailLimit, async(req,res,next)=>{
  try{
    const project=findProject(resolvedDiscovery(),req.params.id);if(!project)return res.status(404).json({error:'not_found'});
    const live=await Promise.all(project.components.map(async component=>component.adapter?{...component,detail:await detailFor(component)}:component));
    res.set('Cache-Control','no-store');return res.json({project:{...project,components:live},refreshedAt:Date.now(),refreshMs:5000});
  }catch(error){return next(error)}
});
router.get('/deployments',async(req,res,next)=>{try{return res.json({projects:await deployments()})}catch(e){return next(e)}});
router.get('/filesystem',detailLimit,async(req,res,next)=>{try{const result=await filesystemBrowse(String(req.query.path||'/'),String(req.query.q||''));if(!result)return res.status(503).json({error:'filesystem_index_unavailable'});return res.json(result)}catch(e){return next(e)}});
export default router;