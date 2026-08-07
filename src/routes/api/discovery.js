import express from 'express';import fs from 'node:fs';import path from 'node:path';import {requireSameOrigin} from '../../security.js';import {actionLimit} from './limits.js';import {config} from '../../config.js';import {readDiscoverySettings,resolvedDiscovery,writeDiscoverySettings} from '../../discovery/store.js';
const router=express.Router();
const rescanMarker=path.join(config.stateDir,'discovery-rescan');
function integrationState(){return{telegram:{configured:Boolean(config.telegram.botToken&&config.telegram.chatId),requiresSecret:true,command:'sudo sentinelctl configure telegram'},ai:{configured:fs.existsSync(config.aiBridgeSocket),requiresSecret:true,command:'sudo sentinelctl configure ai'},cloudflare:{configured:process.env.SENTINEL_PROXY_MODE==='cloudflare'},email:{configured:Boolean(process.env.LE_EMAIL)}}}
router.get('/discovery',(req,res)=>{res.set('Cache-Control','no-store');res.json(resolvedDiscovery())});
router.put('/discovery/settings',requireSameOrigin,actionLimit,(req,res)=>res.json({ok:true,settings:writeDiscoverySettings(req.body||{})}));
router.post('/discovery/rescan',requireSameOrigin,actionLimit,(req,res)=>{fs.writeFileSync(rescanMarker,String(Date.now()),{mode:0o600});res.status(202).json({ok:true,status:'queued'})});
router.get('/setup',(req,res)=>{const discovery=resolvedDiscovery();res.set('Cache-Control','no-store');res.json({completed:Boolean(discovery.settings.completedAt),completedAt:discovery.settings.completedAt,discovery:{generatedAt:discovery.generatedAt,summary:discovery.summary,itemCount:discovery.items.length},integrations:integrationState(),steps:['welcome','discovery','targets','integrations','review']})});
router.post('/setup/complete',requireSameOrigin,actionLimit,(req,res)=>res.json({ok:true,settings:writeDiscoverySettings({...req.body,complete:true})}));
export default router;
