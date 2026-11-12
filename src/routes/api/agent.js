import crypto from 'node:crypto';
import express from 'express';
import { requireSameOrigin } from '../../security.js';
import { detailLimit,agentLimit } from './limits.js';
import { callAgent, listAgentModels } from '../../agent-client.js';
import { resolvedDiscovery } from '../../discovery/store.js';
import { buildProjectGraph } from '../../discovery/graph.js';
import { integrationStatus } from '../../integration-client.js';
const router=express.Router();

function forgeProjects(){const graph=buildProjectGraph(resolvedDiscovery());return[{id:'vps',name:'Весь VPS',detail:'Система и обнаруженные сервисы',path:null},...graph.projects.filter(project=>project.path&&project.components.length).map(project=>({id:project.id,name:project.name,detail:`${project.health.runtimeCount} runtime · ${project.components.length} components`,path:project.path}))]}
// Models come from the bridge, which asks the gateway; the installer's list is only the fallback when it is unreachable.
async function forgeModels(){let configured=[];try{configured=(await integrationStatus()).ai?.models||configured}catch{}try{const listed=await listAgentModels();return{models:listed.models.length?listed.models:configured,defaultModel:listed.configured[0]||configured[0]||null,source:listed.models.length&&!listed.error?'gateway':'config'}}catch{return{models:configured,defaultModel:configured[0]||null,source:'config'}}}
router.get('/agent/projects',async(req,res)=>{const m=await forgeModels();res.set('Cache-Control','no-store');res.json({projects:forgeProjects(),models:m.models,defaultModel:m.defaultModel,modelSource:m.source,discoveryManaged:true})});

const agentJobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of agentJobs) if (job.createdAt < cutoff) agentJobs.delete(id);
}, 5 * 60_000).unref();

router.post('/agent/chat', requireSameOrigin, agentLimit, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'bad_messages' });
  const offered=await forgeModels();
  const allowedModels = new Set(offered.models);
  const allowedScopes=new Set(forgeProjects().map(project=>project.id));
  const model = allowedModels.has(String(req.body?.model)) ? String(req.body.model) : offered.defaultModel;
  const scope = allowedScopes.has(String(req.body?.scope)) ? String(req.body.scope) : 'vps';
  const id = crypto.randomUUID();
  const job = { id, status: 'running', createdAt: Date.now(), model, scope };
  agentJobs.set(id, job);
  callAgent(messages, { model, scope }).then((answer) => {
    Object.assign(job, { status: 'done', answer, completedAt: Date.now() });
  }).catch((e) => {
    Object.assign(job, { status: 'error', error: e.status === 409 ? 'agent_busy' : e.message === 'agent_timeout' ? 'agent_timeout' : /^all_models_failed/.test(e.message) ? e.message.replace(/[\u0000-\u001F\u007F]+/g, ' ').slice(0, 500) : 'agent_failed', completedAt: Date.now() });
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

export default router;
