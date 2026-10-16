import http from 'node:http';
import { config } from '../config.js';

/** The web service's only way to the change broker: one owner-only unix socket. */
export function brokerRequest(method, route, payload, { socketPath = config.changes.socket, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw = (raw + chunk).slice(-2_000_000); });
      res.on('end', () => {
        let data = {};
        try { data = JSON.parse(raw); } catch { /* handled below */ }
        if ((res.statusCode || 500) >= 400) return reject(Object.assign(new Error(data.error || 'broker_failed'), { status: res.statusCode, body: data }));
        return resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('broker_timeout'), { status: 504 })));
    req.on('error', error => reject(Object.assign(error, { status: error.status || (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 503 : 502), message: error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'broker_unavailable' : error.message })));
    req.end(body);
  });
}

export const broker = {
  health: () => brokerRequest('GET', '/health', undefined, { timeoutMs: 4000 }),
  challenge: payload => brokerRequest('POST', '/challenge', payload),
  apply: payload => brokerRequest('POST', '/apply', payload, { timeoutMs: 20 * 60_000 }),
  rollback: payload => brokerRequest('POST', '/rollback', payload, { timeoutMs: 20 * 60_000 }),
  changes: (limit = 50) => brokerRequest('GET', `/changes?limit=${limit}`),
  change: id => brokerRequest('GET', `/changes/${encodeURIComponent(id)}`),
  probe: payload => brokerRequest('POST', '/probe', payload, { timeoutMs: 40_000 }),
  journal: (limit = 100) => brokerRequest('GET', `/journal?limit=${limit}`),
};
