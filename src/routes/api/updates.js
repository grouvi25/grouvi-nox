import express from 'express';
import { requireSameOrigin } from '../../security.js';
import { actionLimit } from './limits.js';
import { checkForUpdates, updateState } from '../../updates.js';
import { startUpdateJob, updateJobStatus } from '../../integration-client.js';
const router=express.Router();
router.get('/update',async(req,res)=>{res.set('Cache-Control','no-store');let release=updateState();if(!release.checkedAt)release=await checkForUpdates();let job={status:'unavailable',running:false};try{job=await updateJobStatus()}catch{}res.json({release,job})});
router.post('/update/install',requireSameOrigin,actionLimit,async(req,res,next)=>{try{let release=updateState();if(!release.checkedAt)release=await checkForUpdates();if(!release.available)return res.status(409).json({error:'already_current'});const job=await startUpdateJob();return res.status(202).json({ok:true,job})}catch(error){return next(error)}});
export default router;
