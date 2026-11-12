import http from 'node:http';
import {config} from './config.js';

const socketPath=config.aiBridgeSocket;

export function callAgent(messages, { model = 'glm-5.2', scope = 'vps', timeoutMs = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages, model, scope });
    const req = http.request({ socketPath, path: '/chat', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw = (raw + c).slice(-70000); });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(raw); } catch { /* handled below */ }
        if (res.statusCode !== 200) return reject(Object.assign(new Error(data.error || `agent_http_${res.statusCode}`), { status: res.statusCode }));
        return resolve(String(data.answer || '').trim());
      });
    });
    req.on('timeout', () => req.destroy(new Error('agent_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
/** The models the bridge can use: the configured ones first, then what the gateway offers. */
export function listAgentModels({ timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/models', method: 'GET', timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw = (raw + c).slice(-60000); });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode !== 200) return reject(new Error(`agent_http_${res.statusCode}`));
          return resolve({ models: Array.isArray(data.models) ? data.models : [], configured: Array.isArray(data.configured) ? data.configured : [], error: data.error || null });
        } catch { return reject(new Error('agent_models_unreadable')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('agent_timeout')));
    req.on('error', reject);
    req.end();
  });
}
