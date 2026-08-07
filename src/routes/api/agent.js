import crypto from 'node:crypto';
import express from 'express';
import { requireSameOrigin } from '../../security.js';
import { detailLimit,agentLimit } from './limits.js';
import { callAgent } from '../../agent-client.js';
const router=express.Router();

router.get('/agent/projects',(req,res)=>{res.set('Cache-Control','no-store');res.json({projects:[{id:'vps',name:'Весь VPS',detail:'Система и обнаруженные сервисы',path:null}],discoveryManaged:true})});

const agentJobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of agentJobs) if (job.createdAt < cutoff) agentJobs.delete(id);
}, 5 * 60_000).unref();

router.post('/agent/chat', requireSameOrigin, agentLimit, async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'bad_messages' });
  const allowedModels = new Set(['DeepSeek-V4-Pro', 'Qwen3.6-35B-A3B']);
  const allowedScopes=new Set(['vps']);
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

export default router;
