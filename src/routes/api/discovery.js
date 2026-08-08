import express from 'express';import fs from 'node:fs';import path from 'node:path';import {requireSameOrigin} from '../../security.js';import {actionLimit} from './limits.js';import {config} from '../../config.js';import {readDiscoverySettings,resolvedDiscovery,writeDiscoverySettings} from '../../discovery/store.js';
import {buildProjectGraph} from '../../discovery/graph.js';
import {configureIntegration,integrationStatus} from '../../integration-client.js';
const router=express.Router();
const rescanMarker=path.join(config.stateDir,'discovery-rescan');
async function integrationState(){try{return await integrationStatus()}catch{return{telegram:{configured:Boolean(config.telegram.botToken&&config.telegram.chatId)},ai:{available:fs.existsSync(config.aiBridgeSocket),configured:fs.existsSync(config.aiBridgeSocket)},brokerUnavailable:true}}}

router.get('/discovery',(req,res)=>{res.set('Cache-Control','no-store');res.json(resolvedDiscovery())});
router.get('/projects',(req,res)=>{res.set('Cache-Control','no-store');res.json(buildProjectGraph(resolvedDiscovery()))});
router.put('/discovery/settings',requireSameOrigin,actionLimit,(req,res)=>res.json({ok:true,settings:writeDiscoverySettings(req.body||{})}));
router.post('/discovery/rescan',requireSameOrigin,actionLimit,(req,res)=>{fs.writeFileSync(rescanMarker,String(Date.now()),{mode:0o600});res.status(202).json({ok:true,status:'queued'})});
router.get('/setup',async(req,res,next)=>{try{const discovery=resolvedDiscovery();res.set('Cache-Control','no-store');res.json({completed:Boolean(discovery.settings.completedAt),completedAt:discovery.settings.completedAt,discovery:{generatedAt:discovery.generatedAt,summary:discovery.summary,itemCount:discovery.items.length},integrations:await integrationState(),steps:['welcome','discovery','targets','integrations','review']})}catch(error){next(error)}});
router.get('/integrations',async(req,res,next)=>{try{res.set('Cache-Control','no-store');res.json(await integrationState())}catch(error){next(error)}});
router.post('/integrations/configure',requireSameOrigin,actionLimit,async(req,res,next)=>{try{res.json(await configureIntegration(req.body||{}))}catch(error){if(error.status===400)return res.status(400).json({error:error.message});next(error)}});
router.post('/setup/complete',requireSameOrigin,actionLimit,(req,res)=>res.json({ok:true,settings:writeDiscoverySettings({...req.body,complete:true})}));
export default router;
